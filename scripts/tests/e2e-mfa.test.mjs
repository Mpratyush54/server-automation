// Unit tests for the e2e MFA helpers in scripts/e2e/checks/common.mjs (#114):
// RFC 6238 TOTP and the adminSession() state machine against a fake API.
// Everything runs on 127.0.0.1 and in a temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOTP_STEP_MS, adminSession, base32Decode, decodeJwt, freshTotp, hotp, totp, totpStep, writeMfaState,
} from '../e2e/checks/common.mjs';

// --- RFC 6238 appendix B -----------------------------------------------------------
const KEYS = {
  sha1: Buffer.from('12345678901234567890'),
  sha256: Buffer.from('12345678901234567890123456789012'),
  sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
};
const VECTORS = [
  // [unix seconds, sha1, sha256, sha512] (8 digits)
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

test('TOTP matches the RFC 6238 test vectors (SHA-1, 6 and 8 digits)', () => {
  for (const [t, sha1] of VECTORS) {
    assert.equal(totp(KEYS.sha1, { time: t * 1000, digits: 8 }), sha1, `t=${t}`);
    assert.equal(totp(KEYS.sha1, { time: t * 1000 }), sha1.slice(-6), `t=${t} (6 digits)`);
  }
});

test('TOTP matches the RFC 6238 test vectors (SHA-256, SHA-512)', () => {
  for (const [t, , sha256, sha512] of VECTORS) {
    assert.equal(totp(KEYS.sha256, { time: t * 1000, digits: 8, algorithm: 'sha256' }), sha256, `t=${t}`);
    assert.equal(totp(KEYS.sha512, { time: t * 1000, digits: 8, algorithm: 'sha512' }), sha512, `t=${t}`);
  }
});

test('HOTP matches RFC 4226 appendix D', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, i) => assert.equal(hotp(KEYS.sha1, i), code));
});

test('base32 secrets decode as RFC 4648 (case, padding and spaces ignored)', () => {
  // "12345678901234567890" in base32.
  const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.deepEqual(base32Decode(b32), KEYS.sha1);
  assert.deepEqual(base32Decode(b32.toLowerCase().replace(/(.{4})/g, '$1 ')), KEYS.sha1);
  assert.deepEqual(base32Decode('MZXW6==='), Buffer.from('foo'));
  assert.equal(totp(b32, { time: 59000 }), '287082');
  assert.throws(() => base32Decode('not-base32!'), /invalid base32/);
});

test('freshTotp waits for the next step when the current one was used', async () => {
  const clock = { t: 1_700_000_000_000 + 5000 };
  const sleeps = [];
  const opts = { now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, log: () => {} };
  const state = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', lastStep: 0 };
  const a = await freshTotp(state, opts);
  assert.equal(sleeps.length, 0);
  assert.equal(a.step, totpStep(clock.t));
  state.lastStep = a.step;
  const b = await freshTotp(state, opts);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0 && sleeps[0] <= TOTP_STEP_MS + 1000, `waited ${sleeps[0]} ms`);
  assert.equal(b.step, a.step + 1);
  assert.notEqual(b.code, a.code);
});

// --- adminSession against a fake API ------------------------------------------------
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (claims) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;
const RECOVERY = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`);

function fakeApi({ requireMfa = true, clock }) {
  const user = { email: 'admin@example.test', password: 'pw-e2e', secret: null, pending: null, lastStep: 0 };
  const calls = [];
  const check = (secret, code) => {
    for (const d of [-1, 0, 1]) {
      if (totp(secret, { time: clock.t + d * TOTP_STEP_MS }) === code) {
        const step = totpStep(clock.t) + d;
        if (step <= user.lastStep) return false; // replay
        user.lastStep = step;
        return true;
      }
    }
    return false;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      calls.push(req.url);
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/api/auth/login') {
        if (body.email !== user.email || body.password !== user.password) return send(401, { error: 'Invalid credentials.' });
        if (user.secret) return send(200, { mfa_required: true, challengeToken: 'challenge-1' });
        if (requireMfa) return send(200, { token: fakeJwt({ amr: ['pwd'], mfa_enroll: true }), mfaEnrollmentRequired: true });
        return send(200, { token: fakeJwt({ amr: ['pwd'] }) });
      }
      if (req.url === '/api/auth/mfa/enroll') {
        if (!decodeJwt(auth)?.mfa_enroll) return send(401, {});
        user.pending = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        user.lastStep = 0;
        return send(200, { secret: user.pending, otpauthUri: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AA==' });
      }
      if (req.url === '/api/auth/mfa/verify') {
        if (!user.pending || !check(user.pending, body.code)) return send(400, { error: 'invalid_code' });
        user.secret = user.pending;
        return send(200, { recoveryCodes: RECOVERY, token: fakeJwt({ amr: ['pwd', 'otp', 'mfa'] }) });
      }
      if (req.url === '/api/auth/mfa/challenge') {
        if (body.challengeToken !== 'challenge-1') return send(401, { error: 'invalid_challenge' });
        if (!check(user.secret, body.code)) return send(401, { error: 'invalid_code' });
        return send(200, { token: fakeJwt({ amr: ['pwd', 'otp', 'mfa'] }) });
      }
      return send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ user, calls, api: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}

function harness(fake, clock, extra = {}) {
  const sleeps = [];
  const logs = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mfa-'));
  const opts = {
    api: fake.api,
    email: fake.user.email,
    password: fake.user.password,
    stateFile: path.join(dir, 'admin-mfa.json'),
    now: () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    log: (m) => logs.push(m),
    retryDelayMs: 0,
    ...extra,
  };
  return { opts, sleeps, logs, read: () => JSON.parse(readFileSync(opts.stateFile, 'utf8')) };
}

test('adminSession: enrolment-only session -> enrols and stores secret and recovery codes (0600)', async () => {
  const clock = { t: 1_800_000_000_000 };
  const fake = await fakeApi({ clock });
  try {
    const h = harness(fake, clock);
    const s = await adminSession(h.opts);
    assert.equal(s.kind, 'enrolled');
    assert.deepEqual(decodeJwt(s.token).amr, ['pwd', 'otp', 'mfa']);
    const state = h.read();
    assert.equal(state.secret, fake.user.secret);
    assert.deepEqual(state.recoveryCodes, RECOVERY);
    assert.equal(state.lastStep, totpStep(clock.t));
    assert.equal(state.pending, undefined);
    if (process.platform !== 'win32') assert.equal(statSync(h.opts.stateFile).mode & 0o777, 0o600);
    assert.deepEqual(fake.calls, ['/api/auth/login', '/api/auth/mfa/enroll', '/api/auth/mfa/verify']);
    for (const m of h.logs) assert.ok(!m.includes(state.secret), 'secret logged');
  } finally { await fake.close(); }
});

test('adminSession: mfa_required -> challenge; waits for the next step after a used one', async () => {
  const clock = { t: 1_800_000_000_000 + 2000 };
  const fake = await fakeApi({ clock });
  try {
    const h = harness(fake, clock);
    await adminSession(h.opts); // enrol: uses the current step
    const enrolStep = h.read().lastStep;
    fake.calls.length = 0;
    const s = await adminSession(h.opts);
    assert.equal(s.kind, 'challenge');
    assert.equal(h.sleeps.length, 1, 'waited once for a fresh step');
    assert.ok(h.sleeps[0] > 0 && h.sleeps[0] <= TOTP_STEP_MS + 1000);
    assert.equal(h.read().lastStep, enrolStep + 1);
    assert.deepEqual(fake.calls, ['/api/auth/login', '/api/auth/mfa/challenge']);
    assert.match(h.logs.join('\n'), /waiting \d+ s for the next TOTP step/);
    // A later session in a new step does not wait.
    clock.t += 5 * TOTP_STEP_MS;
    const again = await adminSession(h.opts);
    assert.equal(again.kind, 'challenge');
    assert.equal(h.sleeps.length, 1);
  } finally { await fake.close(); }
});

test('adminSession: a step used elsewhere (replay) is retried once with the next step', async () => {
  const clock = { t: 1_800_000_000_000 + 2000 };
  const fake = await fakeApi({ clock });
  try {
    const h = harness(fake, clock);
    await adminSession(h.opts);
    clock.t += 3 * TOTP_STEP_MS;
    fake.user.lastStep = totpStep(clock.t); // the current step was consumed by another process
    fake.calls.length = 0;
    const s = await adminSession(h.opts);
    assert.equal(s.kind, 'challenge');
    assert.deepEqual(fake.calls, ['/api/auth/login', '/api/auth/mfa/challenge', '/api/auth/mfa/challenge']);
    assert.equal(h.sleeps.length, 1);
    assert.equal(h.read().lastStep, fake.user.lastStep);
  } finally { await fake.close(); }
});

test('adminSession: role without mandatory MFA gets the password session; nothing stored', async () => {
  const clock = { t: 1_800_000_000_000 };
  const fake = await fakeApi({ clock, requireMfa: false });
  try {
    const h = harness(fake, clock);
    const s = await adminSession(h.opts);
    assert.equal(s.kind, 'password');
    assert.ok(!existsSync(h.opts.stateFile));
  } finally { await fake.close(); }
});

test('adminSession: clear errors for missing state, no state file and bad password', async () => {
  const clock = { t: 1_800_000_000_000 };
  const fake = await fakeApi({ clock });
  try {
    await assert.rejects(adminSession(harness(fake, clock, { stateFile: '' }).opts), /no MFA state file/);
    await assert.rejects(adminSession(harness(fake, clock, { password: 'nope' }).opts), /admin login failed: HTTP 401/);
    await adminSession(harness(fake, clock).opts); // enrolled with a state file that is then lost
    clock.t += TOTP_STEP_MS;
    await assert.rejects(adminSession(harness(fake, clock).opts), /no stored TOTP secret/);
  } finally { await fake.close(); }
});

// The platform rate-limits sign-ins per IP; checks reuse the cached admin
// session from the state file until it is about to expire.
test('adminSession reuses a cached session until expiry; fresh:true logs in again', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mfa-cache-'));
  const stateFile = path.join(dir, 'admin-mfa.json');
  const jwt = (exp) => ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ exp, amr: ['pwd', 'otp', 'mfa'] })).toString('base64url'), 'sig'].join('.');
  const now = () => 1_800_000_000_000;
  const valid = jwt(now() / 1000 + 3600);
  writeMfaState({ secret: 'JBSWY3DPEHPK3PXP', recoveryCodes: [], lastStep: 0, session: { token: valid, kind: 'challenge' } }, stateFile);
  // An unreachable API: any network call would throw.
  const opts = { api: 'http://127.0.0.1:9', email: 'a@e.test', password: 'x', stateFile, now, loginAttempts: 1, retryDelayMs: 1 };
  const hit = await adminSession(opts);
  assert.equal(hit.token, valid);
  assert.equal(hit.kind, 'challenge');
  await assert.rejects(adminSession({ ...opts, fresh: true }), 'fresh:true must not use the cache');
  writeMfaState({ secret: 'JBSWY3DPEHPK3PXP', recoveryCodes: [], lastStep: 0, session: { token: jwt(now() / 1000 + 60), kind: 'challenge' } }, stateFile);
  await assert.rejects(adminSession(opts), 'a session expiring within 2 minutes must not be reused');
});
