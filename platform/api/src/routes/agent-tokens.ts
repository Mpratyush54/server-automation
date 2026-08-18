import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { getDb } from '../config/database';
import { AgentToken } from '../entities/AgentToken';
import {
  AuthenticatedRequest,
  expressAuthenticate,
  expressRequireRole,
  logAudit,
  AGENT_TOKEN_PREFIX,
  AGENT_TOKEN_LOOKUP_LEN,
} from '../middleware/auth';
import { UserRole } from '../entities/User';

const router = Router();

export const DEFAULT_AGENT_SCOPES = [
  'commands:validate',
  'commands:execute',
  'projects:read',
  'logs:read',
  'cluster:read',
  'audit:read',
  'bootstrap:read',
];

function publicTokenView(token: AgentToken) {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    createdByUserId: token.createdByUserId,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    isActive: token.isActive,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

function generateAgentSecret(): { raw: string; prefix: string } {
  const secret = crypto.randomBytes(24).toString('hex');
  const raw = `${AGENT_TOKEN_PREFIX}${secret}`;
  const prefix = raw.slice(0, AGENT_TOKEN_LOOKUP_LEN);
  return { raw, prefix };
}

/** GET /api/agent-tokens/me — identity for the current agent token (or human JWT). */
router.get('/agent-tokens/me', expressAuthenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  if (authReq.agentToken) {
    try {
      const ds = await getDb();
      const token = await ds.getRepository(AgentToken).findOne({ where: { id: authReq.agentToken.id } });
      if (!token) {
        return res.status(404).json({ error: 'Agent token not found' });
      }
      return res.json({
        type: 'agent_token',
        ...publicTokenView(token),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to load agent token' });
    }
  }

  if (authReq.user) {
    return res.json({
      type: 'human',
      id: authReq.user.id,
      email: authReq.user.email,
      name: authReq.user.name,
      role: authReq.user.role,
    });
  }

  return res.status(401).json({ error: 'Unauthorized' });
});

/** GET /api/agent-tokens — list tokens (human admins/devops). */
router.get(
  '/agent-tokens',
  expressAuthenticate,
  expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]),
  async (_req: Request, res: Response) => {
    try {
      const ds = await getDb();
      const tokens = await ds.getRepository(AgentToken).find({ order: { createdAt: 'DESC' } });
      return res.json(tokens.map(publicTokenView));
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to list agent tokens' });
    }
  },
);

/** POST /api/agent-tokens — create token (returns raw secret once). */
router.post(
  '/agent-tokens',
  expressAuthenticate,
  expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { name, scopes, expiresAt } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }

      const scopeList = Array.isArray(scopes) && scopes.length > 0
        ? scopes.map(String)
        : [...DEFAULT_AGENT_SCOPES];

      const { raw, prefix } = generateAgentSecret();
      const tokenHash = await bcrypt.hash(raw, 10);

      const ds = await getDb();
      const repo = ds.getRepository(AgentToken);
      const entity = repo.create({
        name: name.trim(),
        tokenPrefix: prefix,
        tokenHash,
        scopes: scopeList,
        createdByUserId: authReq.user?.id || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        revokedAt: null,
        isActive: true,
        lastUsedAt: null,
      });
      const saved = await repo.save(entity);

      await logAudit({
        userId: authReq.user?.id,
        action: 'agent_token.create',
        targetType: 'agent_token',
        targetId: saved.id,
        metadata: { name: saved.name, scopes: saved.scopes },
        ip: req.ip,
      });

      return res.status(201).json({
        ...publicTokenView(saved),
        token: raw,
        warning: 'Store this token securely. It will not be shown again.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to create agent token' });
    }
  },
);

/** GET /api/agent-tokens/:id */
router.get(
  '/agent-tokens/:id',
  expressAuthenticate,
  expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]),
  async (req: Request, res: Response) => {
    try {
      const ds = await getDb();
      const token = await ds.getRepository(AgentToken).findOne({ where: { id: req.params.id } });
      if (!token) return res.status(404).json({ error: 'Agent token not found' });
      return res.json(publicTokenView(token));
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to get agent token' });
    }
  },
);

/** PATCH /api/agent-tokens/:id — update name/scopes/active */
router.patch(
  '/agent-tokens/:id',
  expressAuthenticate,
  expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const ds = await getDb();
      const repo = ds.getRepository(AgentToken);
      const token = await repo.findOne({ where: { id: req.params.id } });
      if (!token) return res.status(404).json({ error: 'Agent token not found' });

      const { name, scopes, isActive, expiresAt } = req.body || {};
      if (typeof name === 'string' && name.trim()) token.name = name.trim();
      if (Array.isArray(scopes)) token.scopes = scopes.map(String);
      if (typeof isActive === 'boolean') {
        token.isActive = isActive;
        if (!isActive && !token.revokedAt) token.revokedAt = new Date();
        if (isActive) token.revokedAt = null;
      }
      if (expiresAt === null) token.expiresAt = null;
      else if (expiresAt) token.expiresAt = new Date(expiresAt);

      const saved = await repo.save(token);
      await logAudit({
        userId: authReq.user?.id,
        action: 'agent_token.update',
        targetType: 'agent_token',
        targetId: saved.id,
        metadata: { name: saved.name, isActive: saved.isActive },
        ip: req.ip,
      });
      return res.json(publicTokenView(saved));
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to update agent token' });
    }
  },
);

/** DELETE /api/agent-tokens/:id — revoke */
router.delete(
  '/agent-tokens/:id',
  expressAuthenticate,
  expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const ds = await getDb();
      const repo = ds.getRepository(AgentToken);
      const token = await repo.findOne({ where: { id: req.params.id } });
      if (!token) return res.status(404).json({ error: 'Agent token not found' });

      token.isActive = false;
      token.revokedAt = new Date();
      await repo.save(token);

      await logAudit({
        userId: authReq.user?.id,
        action: 'agent_token.revoke',
        targetType: 'agent_token',
        targetId: token.id,
        ip: req.ip,
      });

      return res.json({ ok: true, id: token.id, revokedAt: token.revokedAt });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to revoke agent token' });
    }
  },
);

export default router;
