#!/usr/bin/env python3
"""Mirror every pinned Helm chart to GHCR (versions.ChartMirror).

Usage: scripts/mirror-charts.py charts.json   (output of `platformctl charts --json`)

Charts already present in the mirror are skipped. Classic-repo charts are
resolved through the repo's index.yaml; downloads from github.com send
$GITHUB_TOKEN, because during GitHub Releases outages anonymous downloads have
failed while authenticated ones kept working. Requires helm (logged in to
ghcr.io with write access).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


def get(url, retries=6):
    headers = {"User-Agent": "platform-mirror-charts"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and urllib.request.urlparse(url).hostname == "github.com":
        headers["Authorization"] = "Bearer " + token
    err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except Exception as e:  # noqa: BLE001 - retried, then reported
            err = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {err}")


def chart_url(repo_url, name, version):
    """First download URL of name@version in a classic repo's index.yaml."""
    index = get(repo_url.rstrip("/") + "/index.yaml").decode()
    for block in re.split(r"\n  - ", index):
        b = "\n" + block + "\n"
        if re.search(r"\n\s*version: ['\"]?%s['\"]?\s*\n" % re.escape(version), b) and re.search(
            r"\n\s*name: ['\"]?%s['\"]?\s*\n" % re.escape(name), b
        ):
            m = re.search(r"urls:\s*\n\s*- ['\"]?([^\s'\"]+)", block)
            if m:
                url = m.group(1)
                return url if url.startswith("http") else repo_url.rstrip("/") + "/" + url
    raise RuntimeError(f"{name} {version} not found in {repo_url}/index.yaml")


def main():
    cfg = json.load(open(sys.argv[1]))
    mirror = cfg["chartMirror"]
    failed = []
    for c in cfg["charts"]:
        base, version = c["chart"].split("/")[-1], c["version"]
        dest = f"{mirror}/{base}"
        if run("helm", "show", "chart", dest, "--version", version, check=False).returncode == 0:
            print(f"present  {base} {version}")
            continue
        try:
            with tempfile.TemporaryDirectory() as tmp:
                if c.get("repoUrl"):
                    data = get(chart_url(c["repoUrl"], c["chart"], version))
                    path = os.path.join(tmp, f"{base}-{version}.tgz")
                    with open(path, "wb") as fh:
                        fh.write(data)
                else:
                    run("helm", "pull", c["chart"], "--version", version, "-d", tmp)
                    path = os.path.join(tmp, os.listdir(tmp)[0])
                meta = run("helm", "show", "chart", path).stdout
                if not re.search(r"^name: %s$" % re.escape(base), meta, re.M) or not re.search(
                    r"^version: ['\"]?%s['\"]?$" % re.escape(version), meta, re.M
                ):
                    raise RuntimeError(f"downloaded archive is not {base} {version}")
                run("helm", "push", path, mirror)
                print(f"mirrored {base} {version}")
        except Exception as e:  # noqa: BLE001 - report every failure, then fail
            print(f"FAILED   {base} {version}: {e}", file=sys.stderr)
            failed.append(base)
    if failed:
        sys.exit("charts not mirrored: " + ", ".join(failed))


if __name__ == "__main__":
    main()
