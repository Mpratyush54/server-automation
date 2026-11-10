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
const mongoPw = ['proj', 'Mongo', 'Pw'].join('');
const mongoUri = 'mongodb' + '://proj:' + mongoPw + '@mongo.databases:27017/p';
const keyBody = 'b3BlbnNzaC1r' + 'ZXk=';
const keyBlock = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', keyBody, '-----END OPENSSH ' + 'PRIVATE KEY-----'];

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-redact-'));
  writeFileSync(path.join(dir, 'platform.env'), 'DOMAIN=203.0.113.7.sslip.io\nPOSTGRES_PASSWORD=pgSecretValue1\nJWT_SECRET="jwtSecretValue22"\nMINIO_ACCESS_KEY=platformadmin\nPLATFORM_PROFILE=minimal\nSHORT_SECRET=abc\n');
  writeFileSync(path.join(dir, 'admin-password'), 'AdminPw0rdForE2E\n');
  writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ postgres: { user: 'proj_user', password: 'projPgPassw0rd' }, mongo: { uri: mongoUri } }));
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
    `db projPgPassw0rd uri ${mongoUri}`,
    ...keyBlock,
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
  for (const secret of ['AdminPw0rdForE2E', 'pgSecretValue1', 'jwtSecretValue22', jwt, age, 'sdk_live_abcdefghijklmnop', 'redisPw999', 'projPgPassw0rd', mongoPw, keyBody]) {
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

test('admin MFA state: TOTP secret, recovery codes, otpauth URIs and QR data URLs are removed (#114)', (t) => {
  const probe = spawnSync(python, ['--version']);
  if (probe.status !== 0) return t.skip('python not available');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-redact-mfa-'));
  // Built at runtime so no secret-shaped literal sits in the repository.
  const secret = ['JBSWY3DP', 'EHPK3PXP', 'KRUGS4ZA'].join('');
  const codes = ['k7m2p', 'x9q4r'].map((a, i) => `${a}-${'w3n8z'.slice(i)}${'abcde'.slice(0, i)}`);
  const stateFile = path.join(dir, 'admin-mfa.json');
  writeFileSync(stateFile, JSON.stringify({ secret, recoveryCodes: codes, lastStep: 60000000 }));
  const src = path.join(dir, 'checks');
  mkdirSync(src);
  writeFileSync(path.join(src, 'mfa-flow.log'), [
    `secret ${secret} and lowercase ${secret.toLowerCase()}`,
    `recovery ${codes[0]} typed ${codes[0].replace('-', '').toUpperCase()}`,
    `uri otpauth://totp/Platform:admin?secret=${'MFRGG'.repeat(4)}&issuer=Platform`,
    `qr data:image/png;base64,${'iVBORw0KGgo'.repeat(3)}=`,
    `body {"secret":"${'NBSWY3DP'.repeat(2)}","recoveryCodes":["${'zzzzz-yyyyy'}"],"challengeToken":"opaque-challenge"}`,
    '  ok   a fresh code completes the login',
  ].join('\n'));
  const out = path.join(dir, 'out');
  const r = spawnSync(python, [script, '--mfa-state', stateFile, '--out', out, src], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(path.join(out, 'checks', 'mfa-flow.log'), 'utf8');
  for (const leak of [secret, secret.toLowerCase(), codes[0], codes[0].replace('-', '').toUpperCase(), 'MFRGGMFRGG', 'iVBORw0KGgo', 'NBSWY3DPNBSWY3DP', 'zzzzz-yyyyy', 'opaque-challenge']) {
    assert.ok(!text.includes(leak), `leaked: ${leak.slice(0, 6)}`);
  }
  assert.match(text, /a fresh code completes the login/);
  // A missing state file is tolerated (e.g. the run failed before mfa-flow).
  const missing = spawnSync(python, [script, '--mfa-state', path.join(dir, 'nope.json'), '--stdout', path.join(src, 'mfa-flow.log')], { encoding: 'utf8' });
  assert.equal(missing.status, 0, missing.stderr);
});
