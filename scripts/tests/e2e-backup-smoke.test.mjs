// Executes scripts/e2e/remote/backup-smoke.sh with a fake platformctl to check
// the command sequence and that the age identity only travels on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../e2e/remote/backup-smoke.sh', import.meta.url));
const posix = (p) => p.replace(/\\/g, '/');
const identity = 'AGE-SECRET-KEY-1' + 'Z'.repeat(58);

const FAKE = String.raw`#!/usr/bin/env bash
{ printf '%s\0' "$@"; printf '\036'; } >> "$FAKE_LOG"
case "$1 $2" in
  "backup init") echo "WARNING: local backups ..." >&2; printf 'Save this identity OFF the server. It will not be shown again:\n%s\n' "$FAKE_IDENTITY" ;;
  "backup --all") echo "  creating backup"; echo "20260109T020000Z" ;;
  "backup list") [ "$FAKE_LIST_MISSING" = 1 ] && echo "nothing" || printf 'ID  SIZE\n20260109T020000Z 12MB\n' ;;
  "backup restore-test") cat > "$FAKE_STDIN" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-backup-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['platformctl', FAKE], ['sqlite3', '#!/bin/sh\n'], ['jq', '#!/bin/sh\n']]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  return { dir, bin, log: path.join(dir, 'log'), stdin: path.join(dir, 'stdin') };
}

function run(ctx, extra = {}) {
  return spawnSync('bash', ['-c', 'PATH="$(cd "$1" && pwd):$PATH"; exec bash "$2"', '_', posix(ctx.bin), posix(script)], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_LOG: posix(ctx.log), FAKE_STDIN: posix(ctx.stdin), FAKE_IDENTITY: identity, E2E_BACKUP_CONFIG: posix(path.join(ctx.dir, 'backup.json')), E2E_BACKUP_TARGET: 'file://' + posix(path.join(ctx.dir, 'backups')), ...extra },
  });
}

test('init, backup, list and restore-test with the identity on stdin only', () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = readFileSync(ctx.log, 'utf8').split('\x1e').filter(Boolean).map((c) => c.split('\0').filter(Boolean));
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['backup init', 'backup --all', 'backup list', 'backup restore-test']);
  const init = calls[0];
  assert.equal(init[init.indexOf('--target') + 1], 'file://' + posix(path.join(ctx.dir, 'backups')));
  // Production defaults stay on the VM's own paths (checked in the source, not executed).
  const src = readFileSync(script, 'utf8');
  assert.match(src, /E2E_BACKUP_TARGET:-file:\/\/\/var\/lib\/platform\/e2e-backups/);
  assert.match(src, /E2E_BACKUP_CONFIG:-\/root\/e2e-backup\.json/);
  assert.equal(init[init.indexOf('--components') + 1], 'config,postgres,mongo,redis,k3s');
  const rt = calls[3];
  assert.equal(rt[rt.indexOf('--from') + 1], '20260109T020000Z');
  assert.ok(calls.every((c) => !c.join(' ').includes(identity)), 'identity passed as an argument');
  assert.equal(readFileSync(ctx.stdin, 'utf8').trim(), identity);
  assert.ok(!r.stdout.includes(identity) && !r.stderr.includes(identity), 'identity printed');
  assert.match(r.stdout, /restore test passed/);
});

test('a backup missing from the listing fails the smoke test', () => {
  const ctx = setup();
  const r = run(ctx, { FAKE_LIST_MISSING: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /backup not listed/);
});
