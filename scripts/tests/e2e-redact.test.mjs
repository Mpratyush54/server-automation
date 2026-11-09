// Unit tests for scripts/e2e/redact.py: secrets never reach uploaded e2e logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../e2e/redact.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
// Built at runtime so no token-shaped literal sits in the repository.
const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJhZG1pbiJ9xx', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
const age = 'AGE-SECRET-KEY-1' + 'Q'.repeat(58);

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-redact-'));
  writeFileSync(path.join(dir, 'platform.env'), 'DOMAIN=203.0.113.7.sslip.io\nPOSTGRES_PASSWORD=pgSecretValue1\nJWT_SECRET="jwtSecretValue22"\nMINIO_ACCESS_KEY=platformadmin\nPLATFORM_PROFILE=minimal\nSHORT_SECRET=abc\n');
  writeFileSync(path.join(dir, 'admin-password'), 'AdminPw0rdForE2E\n');
  writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ postgres: { user: 'proj_user', password: 'projPgPassw0rd' }, mongo: { uri: 'mongodb://proj:projMongoPw@mongo.databases:27017/p' } }));
  const src = path.join(dir, 'raw');
  mkdirSync(path.join(src, 'cluster'), { recursive: true });
  writeFileSync(path.join(src, 'console.log'), [
    'Password: AdminPw0rdForE2E',
    'connecting with pgSecretValue1 and jwtSecretValue22',
    `Authorization: Bearer ${jwt}`,
    `token ${jwt}`,
    age,
    'sdk token sdk_live_abcdefghijklmnop',
    'export REDIS_PASSWORD=redisPw999',
    'db projPgPassw0rd uri mongodb://proj:projMongoPw@mongo.databases:27017/p',
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXk=', '-----END OPENSSH PRIVATE KEY-----',
    'profile minimal on 203.0.113.7.sslip.io, step k3s ok',
  ].join('\n'));
  writeFileSync(path.join(src, 'cluster', 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  return dir;
}

function run(dir, extra) {
  return spawnSync(python, [script, '--env-file', path.join(dir, 'platform.env'), '--secret-file', path.join(dir, 'admin-password'), '--json-secrets', path.join(dir, 'db.json'), ...extra], { encoding: 'utf8' });
}

test('known values and generic token shapes are removed; ordinary text stays', (t) => {
  const probe = spawnSync(python, ['--version']);
  if (probe.status !== 0) return t.skip('python not available');
  const dir = fixture();
  const out = path.join(dir, 'out');
  const r = run(dir, ['--out', out, path.join(dir, 'raw')]);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(path.join(out, 'raw', 'console.log'), 'utf8');
  for (const secret of ['AdminPw0rdForE2E', 'pgSecretValue1', 'jwtSecretValue22', jwt, age, 'sdk_live_abcdefghijklmnop', 'redisPw999', 'projPgPassw0rd', 'projMongoPw', 'b3BlbnNzaC1rZXk=']) {
    assert.ok(!text.includes(secret), `leaked: ${secret.slice(0, 12)}`);
  }
  assert.match(text, /profile minimal on 203\.0\.113\.7\.sslip\.io, step k3s ok/);
  assert.ok(!existsSync(path.join(out, 'raw', 'cluster', 'binary.bin')), 'binary copied');
  assert.match(readFileSync(path.join(out, 'REDACTION-SKIPPED.txt'), 'utf8'), /binary\.bin/);
});

test('--stdout prints a redacted copy and tolerates missing inputs', (t) => {
  const probe = spawnSync(python, ['--version']);
  if (probe.status !== 0) return t.skip('python not available');
  const dir = fixture();
  const r = run(dir, ['--stdout', path.join(dir, 'raw', 'console.log')]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('AdminPw0rdForE2E'));
  assert.match(r.stdout, /\[REDACTED\]/);
  const missing = spawnSync(python, [script, '--env-file', path.join(dir, 'nope.env'), '--stdout', path.join(dir, 'nope.log')], { encoding: 'utf8' });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, '');
});
