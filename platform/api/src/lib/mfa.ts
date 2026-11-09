import * as crypto from 'crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { authenticator } from 'otplib';
import { IsNull, LessThan } from 'typeorm';
import { getDb } from '../config/database';
import { UserMfa } from '../entities/UserMfa';
import { MfaRecoveryCode } from '../entities/MfaRecoveryCode';
import { IntegrationSettings } from '../entities/IntegrationSettings';
import { User, UserRole } from '../entities/User';
import { encryptValue, decryptValue } from './secrets-encryption';
import { logAudit } from '../middleware/auth';
import { AMR_MFA, AMR_OTP, MFA_CHALLENGE_TTL_SEC, mergeAmr, signMfaChallenge, signSessionToken } from './session-token';

/**
 * TOTP MFA (#24): RFC 6238 codes via otplib, single-use bcrypt-hashed recovery codes,
 * replay protection on the accepted time step, and the `mfa.requiredRoles` policy.
 */

export const TOTP_STEP_SECONDS = 30;
/** Accept the previous and next time step too (clock drift). */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
/** No 0/o/1/l/i: easy to read back from paper. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const BCRYPT_ROUNDS = 10;
export const DEFAULT_MFA_REQUIRED_ROLES: string[] = [UserRole.ADMIN, UserRole.DEVOPS];

export class MfaUnavailableError extends Error {
  readonly status = 500;
}

export function mfaIssuer(): string {
  const explicit = String(process.env.MFA_ISSUER || '').trim();
  if (explicit) return explicit;
  const domain = String(process.env.DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return domain ? `Platform (${domain})` : 'Platform';
}

// ---------------------------------------------------------------------------
// TOTP (pure)
// ---------------------------------------------------------------------------

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20); // 160-bit secret, base32
}

export function totpUri(account: string, secret: string, issuer = mfaIssuer()): string {
  return authenticator.keyuri(account, issuer, secret);
}

export function qrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

function totp(nowMs: number) {
  return authenticator.clone({ window: TOTP_WINDOW, step: TOTP_STEP_SECONDS, epoch: nowMs });
}

/** The code for `secret` at `nowMs` (tests and tooling). */
export function totpCode(secret: string, nowMs = Date.now()): string {
  return totp(nowMs).generate(secret);
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function normalizeTotp(code: unknown): string | null {
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  const s = String(code).replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

/** Time step the code belongs to (within ±TOTP_WINDOW), or null when it does not match. */
export function matchTotpStep(secret: string, code: unknown, nowMs = Date.now()): number | null {
  const token = normalizeTotp(code);
  if (!token) return null;
  let delta: number | null;
  try {
    delta = totp(nowMs).checkDelta(token, secret);
  } catch {
    return null;
  }
  return delta === null || delta === undefined ? null : timeStep(nowMs) + delta;
}

export interface TotpCheck { ok: boolean; step?: number; reason?: 'invalid' | 'replay' }

/** Verify a code and reject any time step at or before the last accepted one. */
export function checkTotp(secret: string, code: unknown, lastUsedStep: number, nowMs = Date.now()): TotpCheck {
  const step = matchTotpStep(secret, code, nowMs);
  if (step === null) return { ok: false, reason: 'invalid' };
  if (step <= (lastUsedStep || 0)) return { ok: false, reason: 'replay' };
  return { ok: true, step };
}

// ---------------------------------------------------------------------------
// Recovery codes (pure)
// ---------------------------------------------------------------------------

/** `xxxxx-xxxxx` codes (~49 bits each), shown to the user once. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    let raw = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

export function normalizeRecoveryCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const s = code.toLowerCase().replace(/[\s-]/g, '');
  if (s.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

export function hashRecoveryCode(code: string): Promise<string> {
  const n = normalizeRecoveryCode(code);
  if (!n) throw new Error('invalid recovery code');
  return bcrypt.hash(n, BCRYPT_ROUNDS);
}

// ---------------------------------------------------------------------------
// Secret encryption (SECRETS_ENCRYPTION_KEY, or JWT_SECRET when unset — same as project secrets)
// ---------------------------------------------------------------------------

function encryptionKeys(): string[] {
  return Array.from(new Set([process.env.SECRETS_ENCRYPTION_KEY, process.env.JWT_SECRET].filter((k): k is string => !!k)));
}

export function encryptTotpSecret(secret: string): string {
  const key = encryptionKeys()[0];
  if (!key) throw new MfaUnavailableError('MFA is unavailable: SECRETS_ENCRYPTION_KEY is not configured');
  return encryptValue(secret, key);
}

export function decryptTotpSecret(payload: string): string {
  for (const key of encryptionKeys()) {
    try {
      return decryptValue(payload, key);
    } catch {
      /* try the next key */
    }
  }
  throw new MfaUnavailableError('MFA secret could not be decrypted (encryption key changed?)');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function repos() {
  const ds = await getDb();
  return { mfa: ds.getRepository(UserMfa), codes: ds.getRepository(MfaRecoveryCode) };
}

export async function getUserMfa(userId: string): Promise<UserMfa | null> {
  const { mfa } = await repos();
  return (await mfa.findOne({ where: { userId } })) || null;
}

export async function isMfaEnabled(userId: string): Promise<boolean> {
  const row = await getUserMfa(userId);
  return !!row?.enabledAt;
}

/** Ids of every user with MFA enabled (user list). */
export async function mfaEnabledUserIds(): Promise<Set<string>> {
  const { mfa } = await repos();
  const rows = (await mfa.find({ select: { userId: true, enabledAt: true } as any })) || [];
  return new Set(rows.filter((r) => r.enabledAt).map((r) => r.userId));
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const { codes } = await repos();
  return (await codes.count({ where: { userId, usedAt: IsNull() } })) || 0;
}

export class MfaStateError extends Error {
  constructor(readonly code: 'already_enabled' | 'no_pending_enrollment' | 'not_enrolled', message: string) {
    super(message);
  }
}

/** Issue a new (pending) secret. Refuses when MFA is already enabled. */
export async function startEnrollment(user: Pick<User, 'id' | 'email'>): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string; issuer: string }> {
  const { mfa } = await repos();
  const existing = await mfa.findOne({ where: { userId: user.id } });
  if (existing?.enabledAt) throw new MfaStateError('already_enabled', 'MFA is already enabled. Disable it first to enrol a new authenticator.');
  const secret = generateTotpSecret();
  const row = existing || mfa.create({ userId: user.id });
  row.secretEncrypted = encryptTotpSecret(secret);
  row.enabledAt = null;
  row.lastUsedStep = 0;
  await mfa.save(row);
  const issuer = mfaIssuer();
  const uri = totpUri(user.email, secret, issuer);
  return { secret, otpauthUri: uri, qrDataUrl: await qrDataUrl(uri), issuer };
}

/** Replace all recovery codes of the user; returns the plaintext codes (shown once). */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const { codes } = await repos();
  const plain = generateRecoveryCodes();
  const hashes = await Promise.all(plain.map((c) => hashRecoveryCode(c)));
  await codes.delete({ userId });
  await codes.save(hashes.map((codeHash) => codes.create({ userId, codeHash, usedAt: null })));
  return plain;
}

/** First code from the authenticator app: enables MFA and returns fresh recovery codes. */
export async function confirmEnrollment(userId: string, code: unknown, nowMs = Date.now()): Promise<{ ok: boolean; recoveryCodes?: string[]; reason?: 'invalid' }> {
  const { mfa } = await repos();
  const row = await mfa.findOne({ where: { userId } });
  if (!row) throw new MfaStateError('no_pending_enrollment', 'Start enrolment first (POST /api/auth/mfa/enroll).');
  if (row.enabledAt) throw new MfaStateError('already_enabled', 'MFA is already enabled.');
  const check = checkTotp(decryptTotpSecret(row.secretEncrypted), code, 0, nowMs);
  if (!check.ok) return { ok: false, reason: 'invalid' };
  row.enabledAt = new Date(nowMs);
  row.lastUsedStep = check.step;
  await mfa.save(row);
  return { ok: true, recoveryCodes: await replaceRecoveryCodes(userId) };
}

export interface SecondFactorResult {
  ok: boolean;
  method?: 'totp' | 'recovery_code';
  recoveryCodesRemaining?: number;
  reason?: 'not_enrolled' | 'invalid' | 'replay';
}

/**
 * Verify a TOTP code or a recovery code for a user with MFA enabled. Both are claimed with a
 * conditional UPDATE, so a code is accepted at most once even across API replicas.
 */
export async function verifySecondFactor(userId: string, code: unknown, nowMs = Date.now()): Promise<SecondFactorResult> {
  const { mfa, codes } = await repos();
  const row = await mfa.findOne({ where: { userId } });
  if (!row?.enabledAt) return { ok: false, reason: 'not_enrolled' };

  if (normalizeTotp(code)) {
    const check = checkTotp(decryptTotpSecret(row.secretEncrypted), code, row.lastUsedStep, nowMs);
    if (!check.ok) return { ok: false, reason: check.reason };
    const claimed = await mfa.update({ userId, lastUsedStep: LessThan(check.step) }, { lastUsedStep: check.step });
    if (!claimed?.affected) return { ok: false, reason: 'replay' };
    return { ok: true, method: 'totp' };
  }

  const recovery = normalizeRecoveryCode(code);
  if (!recovery) return { ok: false, reason: 'invalid' };
  const unused = (await codes.find({ where: { userId, usedAt: IsNull() } })) || [];
  for (const c of unused) {
    if (await bcrypt.compare(recovery, c.codeHash)) {
      const claimed = await codes.update({ id: c.id, usedAt: IsNull() }, { usedAt: new Date(nowMs) });
      if (!claimed?.affected) return { ok: false, reason: 'replay' };
      return { ok: true, method: 'recovery_code', recoveryCodesRemaining: unused.length - 1 };
    }
  }
  return { ok: false, reason: 'invalid' };
}

/** Remove the factor and all recovery codes (user disable, admin reset). */
export async function disableMfa(userId: string): Promise<boolean> {
  const { mfa, codes } = await repos();
  const existed = !!(await mfa.findOne({ where: { userId } }));
  await codes.delete({ userId });
  await mfa.delete({ userId });
  return existed;
}

// ---------------------------------------------------------------------------
// Policy: mfa.requiredRoles
// ---------------------------------------------------------------------------

function parseRoleList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const valid = Object.values(UserRole) as string[];
  return Array.from(new Set(list.map((r) => String(r).trim().toLowerCase()).filter((r) => valid.includes(r))));
}

export function validateRequiredRoles(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const valid = Object.values(UserRole) as string[];
  if (!raw.every((r) => typeof r === 'string' && valid.includes(r))) return null;
  return Array.from(new Set(raw as string[]));
}

/**
 * Roles that must use MFA: the stored setting, else MFA_REQUIRED_ROLES (comma list, `none` for
 * no roles), else [admin, devops]. Fails safe to the default when the setting cannot be read.
 */
export async function getMfaRequiredRoles(): Promise<{ roles: string[]; source: 'setting' | 'env' | 'default' }> {
  try {
    const ds = await getDb();
    const rows = await ds.getRepository(IntegrationSettings).find({ order: { createdAt: 'ASC' }, take: 1 });
    const stored = parseRoleList(rows?.[0]?.mfaRequiredRoles);
    if (stored) return { roles: stored, source: 'setting' };
  } catch {
    /* fall through */
  }
  const env = String(process.env.MFA_REQUIRED_ROLES ?? '').trim();
  if (env) return { roles: env.toLowerCase() === 'none' ? [] : parseRoleList(env) || [], source: 'env' };
  return { roles: [...DEFAULT_MFA_REQUIRED_ROLES], source: 'default' };
}

export async function setMfaRequiredRoles(roles: string[]): Promise<void> {
  const { getOrCreateIntegrationSettings } = await import('./integrations');
  const row = await getOrCreateIntegrationSettings();
  row.mfaRequiredRoles = roles;
  const ds = await getDb();
  await ds.getRepository(IntegrationSettings).save(row);
}

export async function isMfaRequiredForRole(role: string): Promise<boolean> {
  return (await getMfaRequiredRoles()).roles.includes(role);
}

// ---------------------------------------------------------------------------
// Login state machine (password and GitHub/GitLab logins)
// ---------------------------------------------------------------------------

export type LoginOutcome =
  | { kind: 'mfa_required'; challengeToken: string; expiresIn: number }
  | { kind: 'session'; token: string; mfaEnrollmentRequired: boolean };

/**
 * After a valid first factor:
 *  - MFA enabled                → `mfa_required` + challenge token (no session yet)
 *  - role requires MFA, none    → session restricted to enrolment (`mfa_enroll`)
 *  - otherwise                  → normal session
 */
export async function completeFirstFactor(user: User, amr: string[], ip?: string): Promise<LoginOutcome> {
  if (await isMfaEnabled(user.id)) {
    return { kind: 'mfa_required', challengeToken: signMfaChallenge(user.id, amr), expiresIn: MFA_CHALLENGE_TTL_SEC };
  }
  if (await isMfaRequiredForRole(user.role)) {
    await logAudit({ userId: user.id, action: 'auth.mfa.enrollment_forced', targetType: 'User', targetId: user.id, metadata: { role: user.role, amr }, ip });
    return { kind: 'session', token: signSessionToken(user, { amr, mfaEnroll: true }), mfaEnrollmentRequired: true };
  }
  return { kind: 'session', token: signSessionToken(user, { amr }), mfaEnrollmentRequired: false };
}

/** Session claims after a successful second factor. */
export function sessionAfterSecondFactor(user: User, firstFactorAmr: string[]): string {
  return signSessionToken(user, { amr: mergeAmr(firstFactorAmr, [AMR_OTP, AMR_MFA]) });
}

/** JSON body for a login outcome (password login and the OAuth exchange share it). */
export function loginResponseBody(outcome: LoginOutcome, user: User): Record<string, unknown> {
  if (outcome.kind === 'mfa_required') {
    return {
      mfa_required: true,
      status: 'mfa_required',
      challengeToken: outcome.challengeToken,
      expiresIn: outcome.expiresIn,
      methods: ['totp', 'recovery_code'],
    };
  }
  const { passwordHash: _ph, ...safe } = user as any;
  return {
    token: outcome.token,
    user: safe,
    ...(outcome.mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}),
  };
}
