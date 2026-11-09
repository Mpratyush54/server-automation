import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/security-env';

/**
 * Portal session and MFA challenge tokens (#24).
 *
 * Session JWT claims: id, email, name, role, plus
 *  - `amr`        RFC 8176 authentication methods: `pwd` (password), `fed` (GitHub/GitLab),
 *                 `otp` + `mfa` once a second factor was verified.
 *  - `auth_time`  when the user last authenticated (seconds); refreshed by step-up.
 *  - `mfa_enroll` set on sessions of users whose role requires MFA but who have not enrolled:
 *                 such a session only reaches the enrolment endpoints (see expressAuthenticate).
 *
 * A challenge token proves the first factor only. It has its own audience and `typ`, so it is
 * never accepted as a session.
 */

export const SESSION_TTL = '24h';
/** Restricted (enrolment-only) sessions are short-lived. */
export const ENROLLMENT_SESSION_TTL = '1h';
export const MFA_CHALLENGE_TTL_SEC = 5 * 60;
export const MFA_CHALLENGE_AUDIENCE = 'platform-mfa-challenge';
export const MFA_CHALLENGE_TYP = 'mfa_challenge';

export const AMR_PASSWORD = 'pwd';
export const AMR_FEDERATED = 'fed';
export const AMR_OTP = 'otp';
export const AMR_MFA = 'mfa';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface SessionOptions {
  amr?: string[];
  /** Seconds since epoch; defaults to now. */
  authTime?: number;
  /** Restrict the session to MFA enrolment. */
  mfaEnroll?: boolean;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** De-duplicated, order-preserving union of method lists. */
export function mergeAmr(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  for (const l of lists) for (const m of l || []) if (typeof m === 'string' && !out.includes(m)) out.push(m);
  return out;
}

export function signSessionToken(user: SessionUser, opts: SessionOptions = {}): string {
  const claims: Record<string, unknown> = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    amr: mergeAmr(opts.amr && opts.amr.length > 0 ? opts.amr : [AMR_PASSWORD]),
    auth_time: opts.authTime ?? nowSeconds(),
  };
  if (opts.mfaEnroll) claims.mfa_enroll = true;
  return jwt.sign(claims, getJwtSecret(), { expiresIn: opts.mfaEnroll ? ENROLLMENT_SESSION_TTL : SESSION_TTL });
}

/** Short-lived token handed out after the first factor when the user has MFA enabled. */
export function signMfaChallenge(userId: string, amr: string[]): string {
  return jwt.sign({ typ: MFA_CHALLENGE_TYP, amr: mergeAmr(amr) }, getJwtSecret(), {
    subject: userId,
    audience: MFA_CHALLENGE_AUDIENCE,
    expiresIn: MFA_CHALLENGE_TTL_SEC,
  });
}

/** Returns the user and first-factor methods of a valid, unexpired challenge token; null otherwise. */
export function verifyMfaChallenge(token: unknown): { userId: string; amr: string[] } | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { audience: MFA_CHALLENGE_AUDIENCE }) as any;
    if (decoded?.typ !== MFA_CHALLENGE_TYP || typeof decoded.sub !== 'string' || !decoded.sub) return null;
    const amr = Array.isArray(decoded.amr) ? decoded.amr.filter((m: unknown) => typeof m === 'string') : [];
    return { userId: decoded.sub, amr };
  } catch {
    return null;
  }
}
