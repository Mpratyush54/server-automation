// Signs the recording browser in to Cairn without showing a password on
// screen: log in through the API once, then put the session where the portal
// keeps it (localStorage `plat_auth_token` and `plat_user_profile`, see
// platform/portal/src/app/services/auth.service.ts) before any page loads.
import { cairnUrl, env } from './config.mjs';
import { freshTotp } from './totp.mjs';

let cached;

/**
 * A portal session: { token, user }. Uses CAIRN_TOKEN when set (a JWT minted
 * elsewhere, so a run does not spend a login or a TOTP step). Otherwise logs
 * in with CAIRN_EMAIL / CAIRN_PASSWORD and, when the account has two-factor
 * sign-in, a code from CAIRN_TOTP_SECRET.
 */
export async function session() {
  if (cached) return cached;
  const base = cairnUrl();
  const preset = env('CAIRN_TOKEN');
  if (preset) {
    const me = await fetch(`${base}/api/users/me`, { headers: { Authorization: `Bearer ${preset}` } });
    if (!me.ok) throw new Error(`CAIRN_TOKEN was refused (${me.status})`);
    cached = { token: preset, user: await me.json() };
    return cached;
  }
  const email = env('CAIRN_EMAIL', { required: true });
  const password = env('CAIRN_PASSWORD', { required: true });
  let totpStep = -1;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (login.status === 429) throw new Error('Too many sign-ins from this address. Wait 15 minutes or set CAIRN_TOKEN.');
  if (!login.ok) throw new Error(`Sign-in failed (${login.status})`);
  let body = await login.json();
  if (body.mfa_required) {
    const secret = env('CAIRN_TOTP_SECRET', { required: true });
    const { code, step } = await freshTotp(secret, Number(env('CAIRN_TOTP_LAST_STEP', { fallback: '-1' })));
    totpStep = step;
    const challenge = await fetch(`${base}/api/auth/mfa/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: body.challengeToken, code }),
    });
    if (!challenge.ok) throw new Error(`Two-factor sign-in failed (${challenge.status})`);
    body = await challenge.json();
  }
  if (!body.token) throw new Error('Sign-in returned no session token');
  // totpStep: the code's time step, so a later step-up in this run waits for the next one.
  cached = { token: body.token, user: body.user ?? {}, totpStep };
  return cached;
}

/** Authenticated call to the Cairn API, for setup that should not be on camera. */
export async function api(path, { method = 'GET', body } = {}) {
  const { token } = await session();
  const response = await fetch(`${cairnUrl()}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} /api${path} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

/** Init script that installs the session before the portal boots. */
export async function sessionInitScript() {
  const { token, user } = await session();
  return {
    content: `try {
      localStorage.setItem('plat_auth_token', ${JSON.stringify(token)});
      localStorage.setItem('plat_user_profile', ${JSON.stringify(JSON.stringify(user))});
    } catch (e) {}`,
  };
}
