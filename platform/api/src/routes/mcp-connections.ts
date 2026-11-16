import { Router, Request, Response } from 'express';
import { In, IsNull } from 'typeorm';
import { getDb } from '../config/database';
import { McpGrant } from '../entities/McpGrant';
import { OAuthClient } from '../entities/OAuthClient';
import { User, UserRole } from '../entities/User';
import { AuthenticatedRequest, expressAuthenticate, logAudit, requireHumanJwt } from '../middleware/auth';
import { revokeGrant } from '../lib/mcp-oauth';
import { effectiveScopes } from '../lib/mcp-scopes';
import { getMcpResourceUrl } from '../lib/mcp-public-url';

/**
 * Connected AI assistants (remote MCP grants, #193) for the portal's AI agents view.
 * Everyone sees and can disconnect their own; admins and devops see and can disconnect all.
 */
const router = Router();

function canManageAll(role: string | undefined): boolean {
  return role === UserRole.ADMIN || role === UserRole.DEVOPS;
}

/** GET /api/mcp/connections */
router.get('/mcp/connections', expressAuthenticate, requireHumanJwt, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const ds = await getDb();
    const all = canManageAll(authReq.user!.role);
    const grants = await ds.getRepository(McpGrant).find({
      where: all ? { revokedAt: IsNull() } : { userId: authReq.user!.id, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: 500,
    });
    const clientIds = Array.from(new Set(grants.map((g) => g.clientRef)));
    const userIds = Array.from(new Set(grants.map((g) => g.userId)));
    const clients = clientIds.length ? await ds.getRepository(OAuthClient).find({ where: { id: In(clientIds) } }) : [];
    const users = userIds.length ? await ds.getRepository(User).find({ where: { id: In(userIds) } }) : [];
    const clientById = new Map<string, OAuthClient>();
    for (const c of clients) clientById.set(c.id, c);
    const userById = new Map<string, User>();
    for (const u of users) userById.set(u.id, u);

    const connections = grants
      .filter((g) => clientById.has(g.clientRef))
      .map((g) => {
        const client = clientById.get(g.clientRef)!;
        const user = userById.get(g.userId);
        return {
          id: g.id,
          clientId: client.clientId,
          name: client.clientName,
          redirectHosts: Array.from(new Set((client.redirectUris || []).map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean))),
          scopes: g.scopes,
          // What it can do today: the grant capped by the person's current role.
          effectiveScopes: user ? effectiveScopes(g.scopes, user.role) : [],
          approvedBy: user ? { id: user.id, name: user.name, email: user.email } : null,
          mine: g.userId === authReq.user!.id,
          createdAt: g.createdAt,
          lastUsedAt: g.lastUsedAt,
        };
      });
    return res.json({ connectorUrl: getMcpResourceUrl(), configured: !!getMcpResourceUrl(), connections });
  } catch (err: any) {
    return res.status(500).json({ error: 'Could not load connected assistants' });
  }
});

/** DELETE /api/mcp/connections/:id — disconnect: revoke the grant and all its tokens at once. */
router.delete('/mcp/connections/:id', expressAuthenticate, requireHumanJwt, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Connection not found' });
  try {
    const ds = await getDb();
    const grant = await ds.getRepository(McpGrant).findOne({ where: { id: req.params.id } });
    if (!grant || grant.revokedAt) return res.status(404).json({ error: 'Connection not found' });
    if (grant.userId !== authReq.user!.id && !canManageAll(authReq.user!.role)) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    await revokeGrant(grant.id, authReq.user!.id);
    const client = await ds.getRepository(OAuthClient).findOne({ where: { id: grant.clientRef } });
    await logAudit({
      userId: authReq.user!.id,
      action: 'mcp.grant.revoke',
      targetType: 'mcp_grant',
      targetId: grant.id,
      metadata: { clientId: client?.clientId, clientName: client?.clientName, ownerUserId: grant.userId, by: 'portal' },
      ip: req.ip,
    });
    return res.json({ ok: true, id: grant.id });
  } catch {
    return res.status(500).json({ error: 'Could not disconnect the assistant' });
  }
});

export default router;
