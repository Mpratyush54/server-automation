import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { Role } from '../entities/Role';
import { expressAuthenticate, expressRequireRole, requirePermission, logAudit, clearPermissionCache, getUserPermissions, AuthenticatedRequest } from '../middleware/auth';
import { Permission } from '../config/permissions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'caps-platform-super-secret-key';
const router = Router();

// Generate RS256 Keypair for OIDC/SSO dynamically on startup
let oauthPrivateKey: string = '';
let oauthPublicKey: string = '';

try {
  const { privateKey: pri, publicKey: pub } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  oauthPrivateKey = pri;
  oauthPublicKey = pub;
  console.log('[oauth] Successfully generated dynamic RSA-2048 keypair for OIDC/SSO.');
} catch (err: any) {
  console.error('[oauth] Failed to generate RSA keypair for OIDC:', err.message);
}

// Map to store temporary authorization codes: code -> session info
const authCodes = new Map<string, { userId: string; clientId: string; redirectUri: string; state: string }>();

router.get('/health', (req: Request, res: Response) => {
  return res.json({ status: 'ok' });
});

router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'User email not found. Run init-demo first.' });
    }

    user.lastLogin = new Date();
    await ds.getRepository(User).save(user);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    return res.json({ token, user });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/auth/gitlab', async (req: Request, res: Response) => {
  // Simulate GitLab OAuth redirect callback
  const redirectUrl = `/api/auth/gitlab/callback?code=mock_gitlab_code`;
  return res.redirect(redirectUrl);
});

router.get('/auth/gitlab/callback', async (req: Request, res: Response) => {
  try {
    const gitlabProfile = {
      id: '123456',
      name: 'GitLab Developer',
      email: 'gitlab_dev@caps.io',
      avatarUrl: 'https://assets.gitlab-static.net/uploads/-/system/user/avatar/123456/avatar.png',
    };

    const ds = await getDb();
    const repo = ds.getRepository(User);
    let user = await repo.findOne({ where: { email: gitlabProfile.email } });

    if (!user) {
      user = repo.create({
        id: uuidv4(),
        name: gitlabProfile.name,
        email: gitlabProfile.email,
        role: UserRole.DEVELOPER,
        gitlabId: gitlabProfile.id,
        avatarUrl: gitlabProfile.avatarUrl,
        lastLogin: new Date(),
      });
      await repo.save(user);
    } else {
      user.lastLogin = new Date();
      user.avatarUrl = gitlabProfile.avatarUrl;
      await repo.save(user);
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const portalUrl = process.env.PORTAL_URL || 'http://localhost:4200';
    return res.redirect(`${portalUrl}/dashboard?token=${token}`);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users/init-demo', async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);

    const demoUsers = [
      { id: '00000000-0000-0000-0000-000000000001', name: 'Admin', email: 'admin@caps.io', role: UserRole.ADMIN },
      { id: '11111111-1111-1111-1111-111111111111', name: 'John Dev', email: 'john@caps.io', role: UserRole.DEVELOPER },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Sarah Lead', email: 'sarah@caps.io', role: UserRole.TECH_LEAD },
      { id: '33333333-3333-3333-3333-333333333333', name: 'DevOps Boss', email: 'devops@caps.io', role: UserRole.DEVOPS },
    ];

    const created: User[] = [];
    for (const demo of demoUsers) {
      const existing = await repo.findOne({ where: { email: demo.email } });
      if (!existing) {
        const user = repo.create(demo);
        const saved = await repo.save(user);
        created.push(saved);
      }
    }

    const all = await repo.find();
    return res.json({
      message: created.length > 0 ? `Created ${created.length} new demo users` : 'All demo users already exist',
      users: all,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/users', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find();
    return res.json(users);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/users', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(User);

    const user = repo.create({
      id: uuidv4(),
      name: body.name,
      email: body.email,
      role: body.role as UserRole,
      gitlabId: body.gitlabId || null,
      avatarUrl: body.avatarUrl || null,
    });
    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.created',
      targetType: 'User',
      targetId: saved.id,
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/users/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (body.name !== undefined) user.name = body.name;
    if (body.email !== undefined) user.email = body.email;
    if (body.role !== undefined) user.role = body.role as UserRole;
    if (body.gitlabId !== undefined) user.gitlabId = body.gitlabId;
    if (body.avatarUrl !== undefined) user.avatarUrl = body.avatarUrl;

    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.updated',
      targetType: 'User',
      targetId: saved.id,
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/users/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    await repo.remove(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.deleted',
      targetType: 'User',
      targetId: req.params.id,
      ip: req.ip,
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users/me', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({
      where: { id: (req as AuthenticatedRequest).user!.id },
      relations: ['roleRef'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/users/me', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: (req as AuthenticatedRequest).user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, avatarUrl } = req.body;
    if (name !== undefined) user.name = name;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

    const saved = await repo.save(user);
    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/users/invite', expressAuthenticate, requirePermission('users.create'), async (req: Request, res: Response) => {
  try {
    const { email, name, roleId, role } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }

    const ds = await getDb();
    const repo = ds.getRepository(User);

    const existing = await repo.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const userRole = (role as UserRole) || UserRole.DEVELOPER;

    const user = repo.create({
      id: uuidv4(),
      name,
      email,
      role: userRole,
      roleId: roleId || null,
    });
    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.invited',
      targetType: 'User',
      targetId: saved.id,
      metadata: { email, role: userRole, roleId },
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/users/:id/role', expressAuthenticate, requirePermission('users.assign-role'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, roleId } = req.body;

    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (role !== undefined) user.role = role as UserRole;
    if (roleId !== undefined) user.roleId = roleId || null;

    const saved = await repo.save(user);
    clearPermissionCache(id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.role-updated',
      targetType: 'User',
      targetId: id,
      metadata: { role: user.role, roleId: user.roleId },
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users/:id/permissions', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({
      where: { id: req.params.id },
      relations: ['roleRef'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const perms = await getUserPermissions({ id: user.id, role: user.role, roleId: user.roleId });
    return res.json({
      userId: user.id,
      role: user.role,
      roleId: user.roleId,
      permissions: Array.from(perms),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/roles', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const roles = await ds.getRepository(Role).find({ order: { name: 'ASC' } });
    return res.json(roles);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/roles/:id', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const role = await ds.getRepository(Role).findOne({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    return res.json(role);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/roles', expressAuthenticate, requirePermission('users.create'), async (req: Request, res: Response) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Role name is required' });

    const ds = await getDb();
    const repo = ds.getRepository(Role);

    const existing = await repo.findOne({ where: { name } });
    if (existing) return res.status(409).json({ error: 'Role with this name already exists' });

    const role = repo.create({
      name,
      description: description || null,
      permissions: permissions || [],
    });
    const saved = await repo.save(role);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.created',
      targetType: 'Role',
      targetId: saved.id,
      metadata: { name, permissionsCount: (permissions || []).length },
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/roles/:id', expressAuthenticate, requirePermission('users.update'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ds = await getDb();
    const repo = ds.getRepository(Role);
    const role = await repo.findOne({ where: { id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res.status(400).json({ error: 'Cannot modify system roles' });
    }

    const { name, description, permissions, isActive } = req.body;
    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions !== undefined) role.permissions = permissions;
    if (isActive !== undefined) role.isActive = isActive;

    const saved = await repo.save(role);

    // Clear permission cache for all users with this role
    const users = await ds.getRepository(User).find({ where: { roleId: id } });
    for (const u of users) clearPermissionCache(u.id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.updated',
      targetType: 'Role',
      targetId: id,
      metadata: { name: role.name },
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/roles/:id', expressAuthenticate, requirePermission('users.delete'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ds = await getDb();
    const repo = ds.getRepository(Role);
    const role = await repo.findOne({ where: { id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res.status(400).json({ error: 'Cannot delete system roles' });
    }

    // Unassign users from this role
    const users = await ds.getRepository(User).find({ where: { roleId: id } });
    for (const u of users) {
      u.roleId = null;
      await ds.getRepository(User).save(u);
      clearPermissionCache(u.id);
    }

    await repo.remove(role);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: id,
      metadata: { name: role.name, affectedUsers: users.length },
      ip: req.ip,
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/permissions', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  const { PERMISSIONS } = require('../config/permissions');
  return res.json(PERMISSIONS);
});

router.post('/roles/:id/permissions/validate', expressAuthenticate, requirePermission('users.update'), async (req: Request, res: Response) => {
  try {
    const { permissions } = req.body;
    const { PERMISSIONS: ALL_PERMS } = require('../config/permissions');
    const valid = (permissions || []).filter((p: string) => p in ALL_PERMS);
    const invalid = (permissions || []).filter((p: string) => !(p in ALL_PERMS));
    return res.json({ valid, invalid, totalValid: valid.length, totalInvalid: invalid.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/oauth/.well-known/openid-configuration', (req: Request, res: Response) => {
  const domain = process.env.DOMAIN || req.headers.host || 'localhost:3000';
  const protocol = process.env.DOMAIN ? 'https' : (req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http');
  const baseUrl = `${protocol}://${domain}/api/oauth`;

  return res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    userinfo_endpoint: `${baseUrl}/userinfo`,
    jwks_uri: `${baseUrl}/jwks`,
    response_types_supported: ['code', 'token', 'id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups']
  });
});

router.get('/oauth/jwks', (req: Request, res: Response) => {
  try {
    if (!oauthPublicKey) {
      return res.status(500).json({ error: 'OAuth public key is not initialized' });
    }
    const pubKeyObject = crypto.createPublicKey(oauthPublicKey);
    const jwk = pubKeyObject.export({ format: 'jwk' }) as any;
    return res.json({
      keys: [
        {
          kid: 'caps-key-1',
          use: 'sig',
          alg: 'RS256',
          kty: 'RSA',
          ...jwk
        }
      ]
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/authorize', async (req: Request, res: Response) => {
  try {
    const { client_id, redirect_uri, response_type, scope, state, token } = req.query as Record<string, string>;
    
    if (!client_id || !redirect_uri) {
      return res.status(400).json({ error: 'client_id and redirect_uri are required' });
    }

    if (!token) {
      // User is not authenticated via API redirection yet. Redirect to portal oauth page
      const host = req.headers.host || 'localhost:3000';
      const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      let portalUrl = process.env.PORTAL_URL;
      if (!portalUrl) {
        if (host.startsWith('api.')) {
          portalUrl = `${protocol}://${host.substring(4)}`;
        } else if (host.includes(':3000')) {
          portalUrl = `${protocol}://${host.replace(':3000', ':4200')}`;
        } else {
          portalUrl = `${protocol}://${host}`;
        }
      }

      const params = new URLSearchParams({
        client_id,
        redirect_uri,
        response_type: response_type || 'code',
        scope: scope || 'openid',
        state: state || ''
      }).toString();

      return res.redirect(`${portalUrl}/oauth/authorize?${params}`);
    }

    // Validate the user's portal JWT token
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired portal token' });
    }

    // Generate authorization code
    const code = uuidv4();
    authCodes.set(code, {
      userId: decoded.id,
      clientId: client_id,
      redirectUri: redirect_uri,
      state: state || ''
    });
    console.log(`[oauth/authorize] Generated code: ${code} for userId: ${decoded.id}, clientId: ${client_id}. Map size: ${authCodes.size}`);

    // Clean up code after 5 minutes
    setTimeout(() => {
      if (authCodes.has(code)) {
        console.log(`[oauth/timeout] Cleaning up expired code: ${code}`);
        authCodes.delete(code);
      }
    }, 5 * 60 * 1000);

    return res.redirect(`${redirect_uri}?code=${code}&state=${state || ''}`);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/oauth/token', async (req: Request, res: Response) => {
  try {
    const { code, client_id, redirect_uri, grant_type } = req.body;
    console.log(`[oauth/token] Received exchange request for code: ${code}, client_id: ${client_id}, redirect_uri: ${redirect_uri}`);
    
    // Extract client_id from HTTP Basic Auth header if not present in body
    let clientId = client_id;
    const authHeader = req.headers.authorization;
    if (!clientId && authHeader && authHeader.toLowerCase().startsWith('basic ')) {
      try {
        const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
        clientId = credentials.split(':')[0];
        console.log(`[oauth/token] Extracted clientId from Basic Auth header: ${clientId}`);
      } catch (e: any) {
        console.error('[oauth/token] Failed to parse basic auth header:', e.message);
      }
    }

    const session = authCodes.get(code);

    if (!session) {
      console.warn(`[oauth/token] Code NOT found in map. Requested code: ${code}. Current map keys:`, Array.from(authCodes.keys()));
      return res.status(400).json({ error: 'Invalid or expired authorization code' });
    }

    // Fall back to session clientId if still undefined
    if (!clientId) {
      clientId = session.clientId;
      console.log(`[oauth/token] Using session clientId fallback: ${clientId}`);
    }

    console.log(`[oauth/token] Found session for code: ${code}. userId: ${session.userId}, clientId: ${session.clientId}`);
    // Optional validation (we consume it once)
    authCodes.delete(code);

    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({ where: { id: session.userId } });
    if (!user) {
      console.warn(`[oauth/token] User not found for userId: ${session.userId}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const host = req.headers.host || 'localhost:3000';
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const issuer = `${protocol}://${host}/api/oauth`;

    // Sign Access Token (standard JWT signed with RSA private key)
    const accessToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      oauthPrivateKey,
      { algorithm: 'RS256', expiresIn: '1h', issuer, audience: clientId, keyid: 'caps-key-1' }
    );

    // Sign ID Token (standard OIDC claims signed with RSA private key)
    const idToken = jwt.sign(
      {
        iss: issuer,
        sub: user.id,
        aud: clientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        name: user.name,
        email: user.email,
        email_verified: true,
        groups: [user.role],
        roles: [user.role]
      },
      oauthPrivateKey,
      { algorithm: 'RS256', keyid: 'caps-key-1' }
    );

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken
    });
  } catch (err: any) {
    console.error('[oauth/token error]', err);
    return res.status(400).json({ error: err.message });
  }
});

router.get('/oauth/userinfo', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header with Bearer token is required' });
    }
    const token = authHeader.split(' ')[1];

    let decoded: any;
    try {
      decoded = jwt.verify(token, oauthPublicKey);
    } catch (err: any) {
      return res.status(401).json({ error: `Invalid access token: ${err.message}` });
    }

    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({ where: { id: decoded.id } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      sub: user.id,
      name: user.name,
      email: user.email,
      email_verified: true,
      groups: [user.role],
      roles: [user.role]
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
