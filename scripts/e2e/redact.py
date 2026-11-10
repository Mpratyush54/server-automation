#!/usr/bin/env python3
"""Redact secrets from e2e logs before they are printed or uploaded.

Known values (from the VM's /etc/platform/.env, the admin password file, JSON
files such as fetched database credentials, and the admin's MFA state: TOTP
secret and recovery codes) are replaced everywhere, plus generic token shapes
(JWTs, SDK/agent tokens, age identities, private keys, otpauth URIs, QR data
URLs, JSON "secret"/"challengeToken"/"recoveryCodes" fields, KEY=value lines
whose key looks secret).

  redact.py [--env-file F] [--secret-file F] [--json-secrets F] [--mfa-state F] --stdout FILE
  redact.py [--env-file F] [--secret-file F] [--json-secrets F] [--mfa-state F] --out DIR SRC...

With --out, each SRC (file or directory) is copied into DIR redacted. Binary
files and files over 50 MB are skipped (listed in DIR/REDACTION-SKIPPED.txt).
Unit-tested by scripts/tests/e2e-redact.test.mjs.
"""
import argparse
import json
import os
import re
import sys

SECRET_KEY = re.compile(r"(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$)", re.I)
MIN_LEN = 6
GENERIC = [
    (re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S), "[REDACTED PRIVATE KEY]"),
    (re.compile(r"AGE-SECRET-KEY-1[0-9A-Z]+"), "[REDACTED AGE IDENTITY]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[REDACTED JWT]"),
    (re.compile(r"\b(sdk_live|sdk_test|plat_agent|plat_pat)_[A-Za-z0-9_-]{8,}"), r"\1_[REDACTED]"),
    (re.compile(r"\b(sdk-[0-9a-f-]{8,}):[^\s\"']+"), r"\1:[REDACTED]"),
    (re.compile(r"(://[^/\s:@\"']+:)[^@\s\"']+@"), r"\1[REDACTED]@"),
    (re.compile(r"otpauth://[^\s\"'<>]+"), "[REDACTED OTPAUTH URI]"),
    (re.compile(r"data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+"), "[REDACTED DATA URL]"),
    (re.compile(r"(?i)(\"(?:secret|totpSecret|challengeToken)\"\s*:\s*\")[^\"]*\""), r'\1[REDACTED]"'),
    (re.compile(r"(?i)(\"recoveryCodes\"\s*:\s*)\[[^\]]*\]"), r'\1["[REDACTED]"]'),
    (re.compile(r"(?i)\b(authorization:\s*(bearer|basic)\s+)[^\s\"']+"), r"\1[REDACTED]"),
    (re.compile(r"(?im)^(\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)\S.*$"), r"\1[REDACTED]"),
]


def env_values(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key, val = key.strip(), val.strip().strip("'\"")
                if SECRET_KEY.search(key) and len(val) >= MIN_LEN:
                    out.append(val)
    except FileNotFoundError:
        pass
    return out


def json_values(path):
    out = []

    def walk(node, key=""):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, k)
        elif isinstance(node, list):
            for v in node:
                walk(v, key)
        elif isinstance(node, str) and len(node) >= MIN_LEN and re.search(r"(?i)pass|secret|token|uri|key", key):
            out.append(node)

    try:
        with open(path, encoding="utf-8") as f:
            walk(json.load(f))
    except (FileNotFoundError, ValueError):
        pass
    return out


def file_values(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return [v.strip() for v in f.read().splitlines() if len(v.strip()) >= MIN_LEN]
    except FileNotFoundError:
        return []


def mfa_values(path):
    """TOTP secret and recovery codes from the admin MFA state (admin-mfa.json)."""
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except (FileNotFoundError, ValueError):
        return []
    if not isinstance(state, dict):
        return []
    out = []
    secret = state.get("secret")
    if isinstance(secret, str) and len(secret) >= MIN_LEN:
        out += [secret, secret.lower()]
    codes = state.get("recoveryCodes")
    for code in codes if isinstance(codes, list) else []:
        if isinstance(code, str) and len(code) >= MIN_LEN:
            # As issued (xxxxx-xxxxx) and without the dash, in either case.
            plain = code.replace("-", "")
            out += [code, code.upper(), plain, plain.upper()]
    return out


def build(args):
    values = []
    for p in args.env_file:
        values += env_values(p)
    for p in args.secret_file:
        values += file_values(p)
    for p in args.json_secrets:
        values += json_values(p)
    for p in args.mfa_state:
        values += mfa_values(p)
    # Longest first so a value containing another is replaced whole.
    values = sorted(set(values), key=len, reverse=True)

    def redact(text):
        for v in values:
            text = text.replace(v, "[REDACTED]")
        for pattern, repl in GENERIC:
            text = pattern.sub(repl, text)
        return text

    return redact


def is_binary(data):
    return b"\0" in data[:8192]


def copy_tree(redact, src, dest_root, skipped):
    src = os.path.normpath(src)
    base = os.path.dirname(src)
    items = []
    if os.path.isdir(src):
        for root, _dirs, files in os.walk(src):
            for name in files:
                items.append(os.path.join(root, name))
    elif os.path.isfile(src):
        items.append(src)
    for path in items:
        rel = os.path.relpath(path, base)
        if os.path.islink(path):
            continue
        if os.path.getsize(path) > 50 * 1024 * 1024:
            skipped.append(rel + " (too large)")
            continue
        with open(path, "rb") as f:
            data = f.read()
        if is_binary(data):
            skipped.append(rel + " (binary)")
            continue
        out = os.path.join(dest_root, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="") as f:
            f.write(redact(data.decode("utf-8", errors="replace")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", action="append", default=[])
    ap.add_argument("--secret-file", action="append", default=[])
    ap.add_argument("--json-secrets", action="append", default=[])
    ap.add_argument("--mfa-state", action="append", default=[])
    ap.add_argument("--stdout", metavar="FILE")
    ap.add_argument("--out", metavar="DIR")
    ap.add_argument("sources", nargs="*")
    args = ap.parse_args()
    redact = build(args)
    if args.stdout:
        try:
            with open(args.stdout, encoding="utf-8", errors="replace") as f:
                sys.stdout.write(redact(f.read()))
        except FileNotFoundError:
            pass
        return 0
    if not args.out:
        ap.error("--stdout or --out is required")
    os.makedirs(args.out, exist_ok=True)
    skipped = []
    for src in args.sources:
        copy_tree(redact, src, args.out, skipped)
    if skipped:
        with open(os.path.join(args.out, "REDACTION-SKIPPED.txt"), "a", encoding="utf-8") as f:
            f.write("\n".join(skipped) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
