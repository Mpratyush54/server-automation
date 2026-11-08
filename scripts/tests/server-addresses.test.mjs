import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../check-server-addresses.mjs', import.meta.url));
test('CI scanner rejects reintroduced addresses and additive custom denylist entries', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'address-check-'));
  const env = { ...process.env, SERVER_ADDRESS_DENYLIST: '' };
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [checker, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(path.join(cwd, 'example.txt'), 'https://platform.example.com\n');
    execFileSync('git', ['add', 'example.txt'], { cwd });
    assert.equal(run().status, 0);
    // Assemble the historical prefix so the test itself stays clean.
    writeFileSync(path.join(cwd, 'example.txt'), ['148', '113', '10', '20'].join('.'));
    assert.equal(run().status, 1);
    assert.match(run().stderr, /example.txt:1: denylisted/);
    const denylist = path.join(cwd, 'extra.txt');
    writeFileSync(denylist, '# Additional deployment-specific domains\nprivate\\.example\\.com\n');
    assert.equal(run([denylist]).status, 1, 'custom list cannot disable built-in patterns');
    writeFileSync(path.join(cwd, 'example.txt'), 'https://private.example.com');
    assert.equal(run().status, 0);
    assert.equal(run([denylist]).status, 1);
    assert.equal(run([], { SERVER_ADDRESS_DENYLIST: denylist }).status, 1);
    writeFileSync(denylist, '[invalid');
    assert.notEqual(run([denylist]).status, 0, 'malformed denylist fails closed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
