import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import {
  expressAuthenticate,
  expressRequireRole,
  requireHumanJwt,
  requireRecentMfa,
  logAudit,
  stepUpMaxAgeSec,
  AuthenticatedRequest,
} from '../middleware/auth';
import { createLimiterStore } from '../lib/rate-limit-store';
import {
  MfaStateError,
  MfaUnavailableError,
  confirmEnrollment,
  disableMfa,
  getMfaRequiredRoles,
  getUserMfa,
  isMfaRequiredForRole,
  remainingRecoveryCodes,
  replaceRecoveryCodes,
  sessionAfterSecondFactor,
  setMfaRequiredRoles,
  startEnrollment,
  validateRequiredRoles,
  verifySecondFactor,
  DEFAULT_MFA_REQUIRED_ROLES,
} from '../lib/mfa';
import { AMR_MFA, AMR_OTP, mergeAmr, signSessionToken, verifyMfaChallenge } from '../lib/session-token';

/**
 * TOTP MFA (#24): enrolment, login challenge, step-up, recovery codes, admin reset and the
 * `mfa.requiredRoles` policy. Every state change and every failed code is audit-logged.
 */
const router = Router();

/**
 * Code-checking endpoints are limited per account (challenge subject or session user, else IP),
 * counted only on failures, with counters in Redis shared by every replica.
 */
const mfaCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.MFA_RATE_LIMIT_MAX) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'too_many_attempts', message: 'Too many verification attempts. Try again later.' },
  store: createLimiterStore('mfa-code'),
  keyGenerator: (req: Request) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.id) return `user:${authReq.user.id}`;
    const challenge = verifyMfaChallenge(req.body?.challengeToken);
    if (challenge) return `user:${challenge.userId}`;
    return `ip:${req.ip}`;
  },
  validate: false,
});

function publicUser(user: User): Record<string, unknown> {
  const { passwordHash: _ph, ...safe } = user as any;
  return { ...safe, hasPassword: !!user.passwordHash };
}

function mfaError(res: Response, err: any) {
  if (err instanceof MfaStateError) {
    const status = err.code === 'already_enabled' ? 409 : 400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  if (err instanceof MfaUnavailableError) {
    return res.status(500).json({ error: 'mfa_unavailable', message: err.message });
  }
  return res.status(500).json({ error: err?.message || 'MFA operation failed' });
}

async function loadUser(id: string): Promise<User | null> {
  const ds = await getDb();
  return ds.getRepository(User).findOne({ where: { id } });
}

/** Session routes below need a human JWT; agent tokens never manage MFA. */
const human = [expressAuthenticate, requireHumanJwt];

/** GET /api/auth/mfa/status */
router.get('/auth/mfa/status', ...human, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user!;
    const row = await getUserMfa(user.id);
    const policy = await getMfaRequiredRoles();
    return res.json({
      enabled: !!row?.enabledAt,
      pending: !!row && !row.enabledAt,
      enabledAt: row?.enabledAt || null,
      recoveryCodesRemaining: row?.enabledAt ? await remainingRecoveryCodes(user.id) : 0,
      required: policy.roles.includes(user.role),
      requiredRoles: policy.roles,
      stepUpMaxAgeSec: stepUpMaxAgeSec(),
      session: {
        amr: authReq.session?.amr || [],
        authTime: authReq.session?.authTime ?? null,
        enrollmentOnly: !!authReq.session?.mfaEnroll,
      },
    });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/** POST /api/auth/mfa/enroll → { otpauthUri, qrDataUrl, secret, issuer } (pending until verified). */
router.post('/auth/mfa/enroll', ...human, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await startEnrollment(authReq.user!);
    await logAudit({ userId: authReq.user!.id, action: 'auth.mfa.enroll_started', targetType: 'User', targetId: authReq.user!.id, ip: req.ip });
    return res.json({ ...result, account: authReq.user!.email });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/**
 * POST /api/auth/mfa/verify { code } — confirms enrolment with the first authenticator code.
 * Returns the recovery codes (shown once) and a full session token (lifts the enrolment-only
 * restriction; counts as a fresh second factor).
 */
router.post('/auth/mfa/verify', ...human, mfaCodeLimiter, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user!.id;
    const result = await confirmEnrollment(userId, req.body?.code);
    if (!result.ok) {
      await logAudit({ userId, action: 'auth.mfa.enroll_failed', targetType: 'User', targetId: userId, metadata: { reason: result.reason }, ip: req.ip });
      return res.status(400).json({ error: 'invalid_code', message: 'That code is not valid. Check the time on your device and try again.' });
    }
    const user = await loadUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAudit({ userId, action: 'auth.mfa.enabled', targetType: 'User', targetId: userId, metadata: { recoveryCodes: result.recoveryCodes.length }, ip: req.ip });
    return res.json({
      recoveryCodes: result.recoveryCodes,
      token: sessionAfterSecondFactor(user, authReq.session?.amr || []),
      user: publicUser(user),
    });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/**
 * POST /api/auth/mfa/challenge { challengeToken, code } — second step of a password or
 * GitHub/GitLab login. `code` is a 6-digit TOTP code or a recovery code (single use).
 */
router.post('/auth/mfa/challenge', mfaCodeLimiter, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const challenge = verifyMfaChallenge(req.body?.challengeToken);
    if (!challenge) {
      return res.status(401).json({ error: 'invalid_challenge', message: 'Sign-in expired. Enter your password again.' });
    }
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: challenge.userId } });
    if (!user || user.isActive === false) {
      return res.status(401).json({ error: 'invalid_challenge', message: 'Sign-in expired. Enter your password again.' });
    }
    const result = await verifySecondFactor(user.id, req.body?.code);
    if (!result.ok) {
      await logAudit({ userId: user.id, action: 'auth.mfa.challenge_failed', targetType: 'User', targetId: user.id, metadata: { reason: result.reason, amr: challenge.amr }, ip: req.ip });
      return res.status(401).json({ error: 'invalid_code', message: 'Invalid or already used code.' });
    }
    user.lastLogin = new Date();
    await repo.save(user);
    await logAudit({
      userId: user.id,
      action: 'auth.mfa.challenge_succeeded',
      targetType: 'User',
      targetId: user.id,
      metadata: { method: result.method, amr: challenge.amr },
      ip: req.ip,
    });
    if (result.method === 'recovery_code') {
      await logAudit({ userId: user.id, action: 'auth.mfa.recovery_code_used', targetType: 'User', targetId: user.id, metadata: { remaining: result.recoveryCodesRemaining }, ip: req.ip });
    }
    return res.json({
      token: sessionAfterSecondFactor(user, challenge.amr),
      user: publicUser(user),
      ...(result.method === 'recovery_code' ? { recoveryCodesRemaining: result.recoveryCodesRemaining } : {}),
    });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/**
 * POST /api/auth/mfa/step-up { code } — re-verify the second factor for step-up protected actions
 * (secret reveal/export, platform secret rotation, agent-token creation). Returns a new session
 * token whose `auth_time` is now.
 */
router.post('/auth/mfa/step-up', ...human, mfaCodeLimiter, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user!.id;
    const result = await verifySecondFactor(userId, req.body?.code);
    if (!result.ok) {
      await logAudit({ userId, action: 'auth.mfa.step_up_failed', targetType: 'User', targetId: userId, metadata: { reason: result.reason }, ip: req.ip });
      if (result.reason === 'not_enrolled') {
        return res.status(400).json({ error: 'mfa_not_enrolled', message: 'Set up an authenticator app on your profile first.' });
      }
      return res.status(400).json({ error: 'invalid_code', message: 'Invalid or already used code.' });
    }
    const user = await loadUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAudit({ userId, action: 'auth.mfa.step_up', targetType: 'User', targetId: userId, metadata: { method: result.method }, ip: req.ip });
    if (result.method === 'recovery_code') {
      await logAudit({ userId, action: 'auth.mfa.recovery_code_used', targetType: 'User', targetId: userId, metadata: { remaining: result.recoveryCodesRemaining }, ip: req.ip });
    }
    return res.json({
      token: signSessionToken(user, { amr: mergeAmr(authReq.session?.amr, [AMR_OTP, AMR_MFA]) }),
      user: publicUser(user),
      maxAgeSec: stepUpMaxAgeSec(),
    });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/** POST /api/auth/mfa/recovery-codes { code } — regenerate (invalidates the old codes). */
router.post('/auth/mfa/recovery-codes', ...human, mfaCodeLimiter, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user!.id;
    const result = await verifySecondFactor(userId, req.body?.code);
    if (!result.ok) {
      await logAudit({ userId, action: 'auth.mfa.recovery_codes_failed', targetType: 'User', targetId: userId, metadata: { reason: result.reason }, ip: req.ip });
      if (result.reason === 'not_enrolled') return res.status(400).json({ error: 'mfa_not_enrolled' });
      return res.status(400).json({ error: 'invalid_code', message: 'Invalid or already used code.' });
    }
    const recoveryCodes = await replaceRecoveryCodes(userId);
    await logAudit({ userId, action: 'auth.mfa.recovery_codes_regenerated', targetType: 'User', targetId: userId, metadata: { count: recoveryCodes.length }, ip: req.ip });
    return res.json({ recoveryCodes });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/** POST /api/auth/mfa/disable { code } — requires a current code; refused when policy requires MFA. */
router.post('/auth/mfa/disable', ...human, mfaCodeLimiter, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user!;
    if (await isMfaRequiredForRole(user.role)) {
      return res.status(403).json({ error: 'mfa_required_by_policy', message: `MFA is required for the ${user.role} role.` });
    }
    const result = await verifySecondFactor(user.id, req.body?.code);
    if (!result.ok) {
      await logAudit({ userId: user.id, action: 'auth.mfa.disable_failed', targetType: 'User', targetId: user.id, metadata: { reason: result.reason }, ip: req.ip });
      if (result.reason === 'not_enrolled') return res.status(400).json({ error: 'mfa_not_enrolled' });
      return res.status(400).json({ error: 'invalid_code', message: 'Invalid or already used code.' });
    }
    await disableMfa(user.id);
    await logAudit({ userId: user.id, action: 'auth.mfa.disabled', targetType: 'User', targetId: user.id, metadata: { method: result.method }, ip: req.ip });
    return res.json({ success: true });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/**
 * POST /api/users/:id/mfa/reset — admin removes another user's factor (lost device). The user
 * re-enrols at next login if their role requires MFA. Needs a recent second factor of the admin.
 */
router.post(
  '/users/:id/mfa/reset',
  expressAuthenticate,
  requireHumanJwt,
  expressRequireRole([UserRole.ADMIN]),
  requireRecentMfa(),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const target = await loadUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      const existed = await disableMfa(target.id);
      await logAudit({
        userId: authReq.user!.id,
        action: 'auth.mfa.admin_reset',
        targetType: 'User',
        targetId: target.id,
        metadata: { email: target.email, hadMfa: existed, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined },
        ip: req.ip,
      });
      return res.json({ success: true, hadMfa: existed });
    } catch (err: any) {
      return mfaError(res, err);
    }
  },
);

/** GET /api/settings/mfa — the `mfa.requiredRoles` policy. */
router.get('/settings/mfa', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (_req: Request, res: Response) => {
  try {
    const policy = await getMfaRequiredRoles();
    return res.json({
      requiredRoles: policy.roles,
      source: policy.source,
      defaultRequiredRoles: DEFAULT_MFA_REQUIRED_ROLES,
      stepUpMaxAgeSec: stepUpMaxAgeSec(),
    });
  } catch (err: any) {
    return mfaError(res, err);
  }
});

/** PUT /api/settings/mfa { requiredRoles } — admin only, with a recent second factor. */
router.put(
  '/settings/mfa',
  expressAuthenticate,
  requireHumanJwt,
  expressRequireRole([UserRole.ADMIN]),
  requireRecentMfa(),
  async (req: Request, res: Response) => {
    try {
      const roles = validateRequiredRoles(req.body?.requiredRoles);
      if (!roles) {
        return res.status(400).json({ error: `requiredRoles must be an array of: ${Object.values(UserRole).join(', ')}` });
      }
      const before = (await getMfaRequiredRoles()).roles;
      await setMfaRequiredRoles(roles);
      await logAudit({
        userId: (req as AuthenticatedRequest).user!.id,
        action: 'settings.mfa.updated',
        targetType: 'settings',
        // audit_logs.target_id is a uuid column: the setting name goes in metadata.
        metadata: { setting: 'mfa.requiredRoles', before, after: roles },
        ip: req.ip,
      });
      return res.json({ requiredRoles: roles, source: 'setting' });
    } catch (err: any) {
      return mfaError(res, err);
    }
  },
);

export default router;
