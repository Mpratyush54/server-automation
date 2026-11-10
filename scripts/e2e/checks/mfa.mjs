// node mfa.mjs flow|breakglass
//
// flow (#24, #114): the MFA login flow against the live install, run before any
// check that needs an admin session. On a fresh install it enrols the admin and
// stores the TOTP secret and recovery codes in $E2E_WORK/admin-mfa.json (0600),
// which every later check uses (adminSession in common.mjs):
//   - an admin without MFA only gets an enrolment session (403 mfa_enrollment_required);
//   - enrolment returns an otpauth URI, a QR data URL and 10 recovery codes;
//   - wrong and reused (replayed) codes are rejected; a fresh code completes the login;
//   - a recovery code works once;
//   - a tech_lead (holds secrets.reveal, MFA not mandatory for the role) gets
//     401 step_up_required when revealing a secret without a recent second factor;
//   - the audit log records auth.mfa.enabled, .recovery_code_used and .challenge_failed.
//
// breakglass: `sudo platformctl mfa disable --user <admin>` on the host (over SSH)
// removes the factor and writes auth.mfa.break_glass_disable; the admin then gets an
// enrolment session again and re-enrols, so later checks keep working.
//
// Secrets, codes and recovery codes are never printed.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOTP_STEP_MS, adminEmail, adminPassword, adminSession, apiUrl, decodeJwt, domain, expect, freshTotp,
  main, readMfaState, request, retry, totp, writeMfaState,
} from './common.mjs';

const mode = process.argv[2];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const api = (p) => `${apiUrl()}/api${p}`;
const bearer = (t) => (t ? { authorization: `Bearer ${t}` } : {});
const call = (method, p, token, body) => request(api(p), { method, headers: bearer(token), body });
const detail = (r) => `HTTP ${r.status}${r.json?.error ? ` ${r.json.error}` : ''}`;

async function passwordLogin(email = adminEmail(), password = adminPassword()) {
  return retry(async () => {
    const r = await call('POST', '/auth/login', null, { email, password });
    if (r.status >= 500) throw new Error(`login HTTP ${r.status}`);
    return r;
  }, { attempts: 6 });
}

const isEnrolmentSession = (r) => r.status === 200 && Boolean(r.json?.token)
  && (r.json.mfaEnrollmentRequired === true || decodeJwt(r.json.token)?.mfa_enroll === true);

/** A 6-digit code that is not valid for the secret in the accepted window (+-1 step). */
function wrongCode(secret) {
  const t = Date.now();
  const valid = new Set([-1, 0, 1].map((d) => totp(secret, { time: t + d * TOTP_STEP_MS })));
  return ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c));
}

async function auditActions(token) {
  const r = await call('GET', '/audit-logs', token);
  return { status: r.status, actions: new Set((Array.isArray(r.json) ? r.json : []).map((l) => l.action)) };
}

async function flow() {
  let state;
  let full;
  let usedCode;
  let enrolledNow = false;
  const first = await passwordLogin();

  if (isEnrolmentSession(first)) {
    expect(true, 'admin password login (MFA required, not enrolled) returns an enrolment session');
    const restricted = first.json.token;
    const blocked = await call('GET', '/projects', restricted);
    expect(blocked.status === 403 && blocked.json?.error === 'mfa_enrollment_required', 'admin without MFA is blocked until enrolment (403 mfa_enrollment_required)', detail(blocked));

    const e = await call('POST', '/auth/mfa/enroll', restricted);
    const enrolled = e.status === 200 && typeof e.json?.secret === 'string'
      && String(e.json.otpauthUri || '').startsWith('otpauth://totp/')
      && String(e.json.qrDataUrl || '').startsWith('data:image/');
    if (!expect(enrolled, 'enrolment returns a secret, an otpauth URI and a QR data URL', detail(e))) return;
    state = { secret: e.json.secret, recoveryCodes: [], lastStep: 0, pending: true };
    writeMfaState(state);

    const wrong = await call('POST', '/auth/mfa/verify', restricted, { code: wrongCode(state.secret) });
    expect(wrong.status === 400 && wrong.json?.error === 'invalid_code', 'wrong code rejected during enrolment', detail(wrong));

    const { code, step } = await freshTotp(state);
    const v = await call('POST', '/auth/mfa/verify', restricted, { code });
    const codes = Array.isArray(v.json?.recoveryCodes) ? v.json.recoveryCodes : [];
    if (!expect(v.status === 200 && Boolean(v.json?.token) && codes.length === 10, 'valid code enables MFA: 10 recovery codes and a full session', `${detail(v)}, ${codes.length} codes`)) return;
    delete state.pending;
    Object.assign(state, { recoveryCodes: codes, lastStep: step, enrolledAt: new Date().toISOString() });
    writeMfaState(state);
    full = v.json.token;
    usedCode = code;
    enrolledNow = true;
    const reach = await call('GET', '/projects', full);
    expect(reach.status === 200, 'full session reaches the API after enrolment', detail(reach));
  } else if (first.status === 200 && first.json?.mfa_required) {
    // Re-run against an install where the suite already enrolled the admin.
    console.log('  note admin is already enrolled (re-run); enrolment assertions skipped');
    state = readMfaState();
    if (!expect(Boolean(state?.secret), 'stored TOTP secret available for the enrolled admin', 'no admin-mfa.json')) return;
    const { code, step } = await freshTotp(state);
    const c = await call('POST', '/auth/mfa/challenge', null, { challengeToken: first.json.challengeToken, code });
    if (!expect(c.status === 200 && Boolean(c.json?.token), 'stored secret completes the challenge', detail(c))) return;
    state.lastStep = step;
    writeMfaState(state);
    full = c.json.token;
    usedCode = code;
  } else {
    expect(false, 'MFA is enforced for the admin role', first.status === 200 ? 'password login returned a full session' : detail(first));
    return;
  }

  // Login now needs the second factor; the challenge token is not a session.
  const l = await passwordLogin();
  const challengeToken = l.json?.challengeToken;
  expect(l.status === 200 && l.json?.mfa_required === true && Boolean(challengeToken) && !l.json?.token, 'password login returns mfa_required and no session', detail(l));
  if (!challengeToken) return;
  const asSession = await call('GET', '/projects', challengeToken);
  expect(asSession.status === 401 || asSession.status === 403, 'challenge token is not accepted as a session', detail(asSession));
  const wrong = await call('POST', '/auth/mfa/challenge', null, { challengeToken, code: wrongCode(state.secret) });
  expect(wrong.status === 401 && wrong.json?.error === 'invalid_code', 'wrong code rejected at the challenge', detail(wrong));
  const replay = await call('POST', '/auth/mfa/challenge', null, { challengeToken, code: usedCode });
  expect(replay.status === 401, 'an already used code is rejected (replay)', detail(replay));
  const { code, step } = await freshTotp(state);
  const fresh = await call('POST', '/auth/mfa/challenge', null, { challengeToken, code });
  if (expect(fresh.status === 200 && Boolean(fresh.json?.token), 'a fresh code completes the login', detail(fresh))) {
    state.lastStep = step;
    writeMfaState(state);
    full = fresh.json.token;
    const amr = decodeJwt(full)?.amr || [];
    expect(amr.includes('mfa') && amr.includes('otp'), 'session amr records otp and mfa', `amr: ${amr.join(',')}`);
  }

  // A recovery code works exactly once (removed from the stored list once used).
  const recovery = state.recoveryCodes?.[0];
  if (expect(Boolean(recovery), 'a stored recovery code is available', 'none left')) {
    const l1 = await passwordLogin();
    const r1 = await call('POST', '/auth/mfa/challenge', null, { challengeToken: l1.json?.challengeToken, code: recovery });
    expect(r1.status === 200 && Boolean(r1.json?.token), 'recovery code logs in', detail(r1));
    state.recoveryCodes = state.recoveryCodes.filter((c) => c !== recovery);
    writeMfaState(state);
    const l2 = await passwordLogin();
    const r2 = await call('POST', '/auth/mfa/challenge', null, { challengeToken: l2.json?.challengeToken, code: recovery });
    expect(r2.status === 401, 'the same recovery code is rejected the second time', detail(r2));
  }

  await stepUp(full);

  const audit = await auditActions(full);
  for (const a of ['auth.mfa.enabled', 'auth.mfa.recovery_code_used', 'auth.mfa.challenge_failed']) {
    // auth.mfa.enabled is only written on enrolment, which a re-run skips.
    if (a === 'auth.mfa.enabled' && !enrolledNow) continue;
    expect(audit.actions.has(a), `audit log contains ${a}`, `audit HTTP ${audit.status}`);
  }
}

/** A role that may reveal secrets, signed in with a password only, must step up first. */
async function stepUp(admin) {
  const s = randomUUID().slice(0, 8);
  const p = await call('POST', '/projects', admin, { name: `e2e-stepup-${s}`, stack: 'nodejs', domain: domain(), description: 'e2e MFA step-up', repositoryUrl: 'https://github.com/Mpratyush54/server-automation' });
  if (!expect(p.status === 201 && Boolean(p.json?.id), 'admin creates a project for the step-up check', detail(p))) return;
  const pid = p.json.id;
  let userId;
  try {
    const proj = await call('GET', `/projects/${pid}`, admin);
    const envId = (proj.json?.environments || [])[0]?.id || null;
    const sec = await call('POST', `/projects/${pid}/secrets`, admin, { key: 'E2E_STEPUP', value: 'step-up-ok', environmentId: envId });
    if (!expect(sec.status === 200 || sec.status === 201, 'admin stores a project secret', detail(sec))) return;
    const own = await call('POST', `/projects/${pid}/secrets/reveal`, admin, { key: 'E2E_STEPUP', environmentId: envId });
    expect(own.status === 200 && own.text.includes('step-up-ok'), 'admin with a fresh second factor can reveal the secret', detail(own));

    const email = `tl-${s}@e2e.test`;
    const password = `Tl-${randomUUID()}`;
    const u = await call('POST', '/users', admin, { name: 'E2E step-up tech lead', email, password, role: 'tech_lead' });
    userId = u.json?.id;
    if (!expect(u.status === 201 && Boolean(userId), 'admin creates a tech_lead user', detail(u))) return;
    const m = await call('POST', `/projects/${pid}/members`, admin, { userId, role: 'developer' });
    if (!expect(m.status === 200 || m.status === 201, 'tech_lead added to the project', detail(m))) return;
    const tl = await passwordLogin(email, password);
    const tlToken = tl.json?.token;
    if (!expect(tl.status === 200 && Boolean(tlToken) && !tl.json?.mfa_required && !isEnrolmentSession(tl), 'tech_lead (MFA not mandatory) logs in with a password only', detail(tl))) return;
    const reveal = await call('POST', `/projects/${pid}/secrets/reveal`, tlToken, { key: 'E2E_STEPUP', environmentId: envId });
    expect(reveal.status === 401 && reveal.json?.error === 'step_up_required', 'secret reveal without a recent second factor returns 401 step_up_required', detail(reveal));
    expect(!reveal.text.includes('step-up-ok'), 'the secret value is not disclosed without step-up');
  } finally {
    // Best-effort cleanup; not part of the assertions.
    if (userId) await call('DELETE', `/users/${userId}`, admin).catch(() => {});
    await call('DELETE', `/projects/${pid}`, admin).catch(() => {});
  }
}

async function breakglass() {
  const email = adminEmail();
  if (!expect(/^[A-Za-z0-9._%+@-]+$/.test(email), 'admin email is safe to pass to the host', 'unexpected characters')) return;
  const before = await adminSession();
  expect(before.kind !== 'password', 'admin has an active second factor before break-glass', `session kind ${before.kind}`);

  // Host check: runs platformctl on the VM over SSH (lib.sh vm_ssh).
  const r = spawnSync('bash', ['-c', 'source "$1/lib.sh" && vm_ssh "sudo platformctl mfa disable --user $2"', '_', path.resolve(HERE, '..'), email], { encoding: 'utf8', timeout: 180000 });
  expect(r.status === 0 && /MFA disabled for/.test(r.stdout || ''), 'platformctl mfa disable removes the admin factor', `exit ${r.status}`);
  if (r.status !== 0) console.log(String(r.stderr || '').split('\n').slice(-5).join('\n'));

  const l = await passwordLogin();
  expect(isEnrolmentSession(l), 'after break-glass, password login returns an enrolment session (policy still enforced)', detail(l));
  if (isEnrolmentSession(l)) {
    const blocked = await call('GET', '/projects', l.json.token);
    expect(blocked.status === 403 && blocked.json?.error === 'mfa_enrollment_required', 'and API access stays blocked until the admin enrols again', detail(blocked));
  }

  // Re-enrol so the rest of the suite keeps working (replaces the stored secret).
  // Fresh login: tokens issued before break-glass stay valid until they expire.
  const after = await adminSession({ fresh: true });
  if (!expect(after.kind === 'enrolled', 'admin re-enrols; the stored TOTP secret is replaced', `session kind ${after.kind}`)) return;
  const reach = await call('GET', '/projects', after.token);
  expect(reach.status === 200, 'the re-enrolled admin reaches the API', detail(reach));
  const audit = await auditActions(after.token);
  expect(audit.actions.has('auth.mfa.break_glass_disable'), 'audit log contains auth.mfa.break_glass_disable', `audit HTTP ${audit.status}`);
}

await main(async () => {
  if (mode === 'flow') await flow();
  else if (mode === 'breakglass') await breakglass();
  else throw new Error('usage: mfa.mjs flow|breakglass');
});
