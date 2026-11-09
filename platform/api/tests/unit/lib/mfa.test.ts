/**
 * TOTP MFA core (#24): verify window, replay protection, recovery code hashing / single use,
 * secret encryption at rest and the mfa.requiredRoles policy.
 */
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({
    getRepository: (entity: any) => {
      const name = typeof entity === 'string' ? entity : entity?.name;
      if (!mockRepos[name]) throw new Error(`no repo for ${name}`);
      return mockRepos[name];
    },
  })),
}));
jest.mock('../../../src/middleware/auth', () => ({ logAudit: (...a: any[]) => mockAudit(...a) }));

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  checkTotp,
  completeFirstFactor,
  confirmEnrollment,
  decryptTotpSecret,
  disableMfa,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getMfaRequiredRoles,
  hashRecoveryCode,
  matchTotpStep,
  normalizeRecoveryCode,
  normalizeTotp,
  remainingRecoveryCodes,
  startEnrollment,
  timeStep,
  totpCode,
  totpUri,
  validateRequiredRoles,
  verifySecondFactor,
  RECOVERY_CODE_COUNT,
} from '../../../src/lib/mfa';
import { MFA_CHALLENGE_AUDIENCE, verifyMfaChallenge } from '../../../src/lib/session-token';

const JWT_SECRET = 'mfa-unit-test-jwt-secret-0123456789abcdef';
const T0 = Date.UTC(2026, 10, 9, 12, 0, 10); // 10 s into a 30 s step

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = 'mfa-unit-test-encryption-key';
  delete process.env.MFA_REQUIRED_ROLES;
  mockRepos.UserMfa = new MemoryRepo(() => ({ enabledAt: null, lastUsedStep: 0 }));
  mockRepos.MfaRecoveryCode = new MemoryRepo(() => ({ usedAt: null }));
  mockRepos.IntegrationSettings = new MemoryRepo();
  mockAudit.mockClear();
});

describe('TOTP verification window', () => {
  const secret = generateTotpSecret();

  it('generates a base32 secret and an otpauth URI with issuer and account', () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpUri('admin@example.test', secret, 'Platform');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Platform:admin%40example\.test\?/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Platform');
  });

  it('accepts the current, previous and next step only', () => {
    const now = T0;
    expect(matchTotpStep(secret, totpCode(secret, now), now)).toBe(timeStep(now));
    expect(matchTotpStep(secret, totpCode(secret, now - 30_000), now)).toBe(timeStep(now) - 1);
    expect(matchTotpStep(secret, totpCode(secret, now + 30_000), now)).toBe(timeStep(now) + 1);
    expect(matchTotpStep(secret, totpCode(secret, now - 60_000), now)).toBeNull();
    expect(matchTotpStep(secret, totpCode(secret, now + 60_000), now)).toBeNull();
  });

  it('rejects malformed codes and codes of another secret', () => {
    expect(matchTotpStep(secret, '12345', T0)).toBeNull();
    expect(matchTotpStep(secret, 'abcdef', T0)).toBeNull();
    expect(matchTotpStep(secret, undefined, T0)).toBeNull();
    expect(matchTotpStep(generateTotpSecret(), totpCode(secret, T0), T0)).toBeNull();
    expect(normalizeTotp(' 123 456 ')).toBe('123456');
  });

  it('rejects a reused or older time step (replay)', () => {
    const code = totpCode(secret, T0);
    const first = checkTotp(secret, code, 0, T0);
    expect(first).toEqual({ ok: true, step: timeStep(T0) });
    expect(checkTotp(secret, code, first.step!, T0)).toEqual({ ok: false, reason: 'replay' });
    // A code from the previous step is also refused once a later step was used.
    expect(checkTotp(secret, totpCode(secret, T0 - 30_000), first.step!, T0)).toEqual({ ok: false, reason: 'replay' });
    expect(checkTotp(secret, totpCode(secret, T0 + 30_000), first.step!, T0 + 30_000).ok).toBe(true);
  });
});

describe('recovery codes', () => {
  it('generates 10 unique, readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });

  it('normalizes case, spaces and dashes; rejects foreign characters', () => {
    expect(normalizeRecoveryCode(' ABCDE-FGHJK ')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode('abcde-fghj0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRecoveryCode('short')).toBeNull();
    expect(normalizeRecoveryCode(12345)).toBeNull();
  });

  it('stores bcrypt hashes, never the code', async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code);
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(hash).not.toContain(code.replace('-', ''));
    expect(await bcrypt.compare(normalizeRecoveryCode(code)!, hash)).toBe(true);
  });
});

describe('TOTP secret encryption at rest', () => {
  it('round-trips with SECRETS_ENCRYPTION_KEY and never stores the plaintext', () => {
    const secret = generateTotpSecret();
    const enc = encryptTotpSecret(secret);
    expect(enc).not.toContain(secret);
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptTotpSecret(enc)).toBe(secret);
  });

  it('still decrypts a secret encrypted with JWT_SECRET before SECRETS_ENCRYPTION_KEY was set', () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    const enc = encryptTotpSecret('JBSWY3DPEHPK3PXP');
    process.env.SECRETS_ENCRYPTION_KEY = 'later-key';
    expect(decryptTotpSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
  });
});

describe('enrolment and second-factor verification (persistence)', () => {
  const user = { id: 'u-1', email: 'admin@example.test' };

  async function enrol(now = T0): Promise<{ secret: string; recoveryCodes: string[] }> {
    const started = await startEnrollment(user);
    expect(started.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const row = mockRepos.UserMfa.rows[0];
    expect(row.secretEncrypted).not.toContain(started.secret);
    expect(row.enabledAt).toBeNull();
    const done = await confirmEnrollment(user.id, totpCode(started.secret, now), now);
    expect(done.ok).toBe(true);
    return { secret: started.secret, recoveryCodes: done.recoveryCodes! };
  }

  it('enables MFA only after a valid first code and stores 10 hashed recovery codes', async () => {
    const started = await startEnrollment(user);
    expect((await confirmEnrollment(user.id, '000000', T0)).ok).toBe(false);
    expect(mockRepos.UserMfa.rows[0].enabledAt).toBeNull();
    const done = await confirmEnrollment(user.id, totpCode(started.secret, T0), T0);
    expect(done.ok).toBe(true);
    expect(mockRepos.UserMfa.rows[0].enabledAt).toBeInstanceOf(Date);
    expect(mockRepos.MfaRecoveryCode.rows).toHaveLength(10);
    for (const r of mockRepos.MfaRecoveryCode.rows) expect(r.codeHash).toMatch(/^\$2/);
    await expect(startEnrollment(user)).rejects.toThrow(/already enabled/);
  });

  it('accepts a TOTP code once (the enrolment code cannot be replayed either)', async () => {
    const { secret } = await enrol();
    expect(await verifySecondFactor(user.id, totpCode(secret, T0), T0)).toEqual({ ok: false, reason: 'replay' });
    const next = T0 + 30_000;
    expect(await verifySecondFactor(user.id, totpCode(secret, next), next)).toEqual({ ok: true, method: 'totp' });
    expect(await verifySecondFactor(user.id, totpCode(secret, next), next)).toEqual({ ok: false, reason: 'replay' });
    expect(await verifySecondFactor(user.id, '123456', next + 30_000)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts each recovery code exactly once', async () => {
    const { recoveryCodes } = await enrol();
    const first = await verifySecondFactor(user.id, recoveryCodes[0].toUpperCase(), T0);
    expect(first).toEqual({ ok: true, method: 'recovery_code', recoveryCodesRemaining: 9 });
    expect(await verifySecondFactor(user.id, recoveryCodes[0], T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(await remainingRecoveryCodes(user.id)).toBe(9);
    expect((await verifySecondFactor(user.id, recoveryCodes[1], T0)).ok).toBe(true);
    expect(await remainingRecoveryCodes(user.id)).toBe(8);
  });

  it('refuses codes for users without MFA and after disable', async () => {
    expect(await verifySecondFactor('nobody', '123456', T0)).toEqual({ ok: false, reason: 'not_enrolled' });
    const { recoveryCodes } = await enrol();
    expect(await disableMfa(user.id)).toBe(true);
    expect(mockRepos.UserMfa.rows).toHaveLength(0);
    expect(mockRepos.MfaRecoveryCode.rows).toHaveLength(0);
    expect(await verifySecondFactor(user.id, recoveryCodes[2], T0)).toEqual({ ok: false, reason: 'not_enrolled' });
  });
});

describe('policy mfa.requiredRoles', () => {
  it('defaults to admin and devops', async () => {
    expect(await getMfaRequiredRoles()).toEqual({ roles: ['admin', 'devops'], source: 'default' });
  });

  it('uses the stored setting, then MFA_REQUIRED_ROLES', async () => {
    process.env.MFA_REQUIRED_ROLES = 'admin,tech_lead,bogus';
    expect(await getMfaRequiredRoles()).toEqual({ roles: ['admin', 'tech_lead'], source: 'env' });
    process.env.MFA_REQUIRED_ROLES = 'none';
    expect(await getMfaRequiredRoles()).toEqual({ roles: [], source: 'env' });
    await mockRepos.IntegrationSettings.save({ id: 's', mfaRequiredRoles: ['viewer'] } as any);
    expect(await getMfaRequiredRoles()).toEqual({ roles: ['viewer'], source: 'setting' });
  });

  it('validates role lists', () => {
    expect(validateRequiredRoles(['admin', 'devops'])).toEqual(['admin', 'devops']);
    expect(validateRequiredRoles(['admin', 'root'])).toBeNull();
    expect(validateRequiredRoles('admin')).toBeNull();
    expect(validateRequiredRoles([])).toEqual([]);
  });
});

describe('login state machine (completeFirstFactor)', () => {
  const admin: any = { id: 'a-1', email: 'a@example.test', name: 'A', role: 'admin' };
  const dev: any = { id: 'd-1', email: 'd@example.test', name: 'D', role: 'developer' };

  it('issues a challenge (not a session) when MFA is enabled', async () => {
    await mockRepos.UserMfa.save({ id: 'm', userId: dev.id, secretEncrypted: encryptTotpSecret(generateTotpSecret()), enabledAt: new Date(), lastUsedStep: 0 });
    const out = await completeFirstFactor(dev, ['pwd']);
    expect(out.kind).toBe('mfa_required');
    const token = (out as any).challengeToken;
    expect(verifyMfaChallenge(token)).toEqual({ userId: dev.id, amr: ['pwd'] });
    const decoded: any = jwt.decode(token);
    expect(decoded.id).toBeUndefined(); // never usable as a session
    expect(decoded.aud).toBe(MFA_CHALLENGE_AUDIENCE);
    expect(decoded.exp - decoded.iat).toBe(300);
  });

  it('gives an admin without MFA an enrolment-only session and audits it', async () => {
    const out: any = await completeFirstFactor(admin, ['pwd'], '10.0.0.1');
    expect(out.kind).toBe('session');
    expect(out.mfaEnrollmentRequired).toBe(true);
    const decoded: any = jwt.verify(out.token, JWT_SECRET);
    expect(decoded.mfa_enroll).toBe(true);
    expect(decoded.amr).toEqual(['pwd']);
    expect(decoded.exp - decoded.iat).toBe(3600);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.mfa.enrollment_forced', userId: admin.id }));
  });

  it('gives a developer without MFA a normal session with amr and auth_time', async () => {
    const out: any = await completeFirstFactor(dev, ['fed']);
    const decoded: any = jwt.verify(out.token, JWT_SECRET);
    expect(out.mfaEnrollmentRequired).toBe(false);
    expect(decoded.mfa_enroll).toBeUndefined();
    expect(decoded.amr).toEqual(['fed']);
    expect(Math.abs(decoded.auth_time - Date.now() / 1000)).toBeLessThan(5);
  });

  it('rejects tampered or foreign challenge tokens', () => {
    expect(verifyMfaChallenge(jwt.sign({ id: 'x' }, JWT_SECRET))).toBeNull();
    expect(verifyMfaChallenge(jwt.sign({ typ: 'mfa_challenge' }, 'other-secret', { audience: MFA_CHALLENGE_AUDIENCE, subject: 'x' }))).toBeNull();
    expect(verifyMfaChallenge('')).toBeNull();
    expect(verifyMfaChallenge(42)).toBeNull();
  });
});
