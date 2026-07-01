import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import { SecretVersion } from '../entities/SecretVersion';
import { expressAuthenticate, requirePermission, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { encryptValue, decryptValue } from '../lib/secrets-encryption';

const MASTER_KEY = () => process.env.SECRETS_ENCRYPTION_KEY || '';
const router = Router();

// List secrets for a project (values masked)
router.get('/projects/:projectId/secrets', expressAuthenticate, requirePermission('secrets.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const secrets = await repo.find({
      where: { projectId: req.params.projectId, isActive: true },
      order: { createdAt: 'DESC' },
    });
    const result = secrets.map(s => ({
      id: s.id,
      key: s.key,
      environmentId: s.environmentId,
      version: s.version,
      maskedValue: s.encryptedValue ? '***' : null,
      createdById: s.createdById,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Reveal a specific secret value (audit-logged)
router.post('/projects/:projectId/secrets/reveal', expressAuthenticate, requirePermission('secrets.reveal'), async (req: Request, res: Response) => {
  try {
    const { environmentId, key } = req.body;
    const userId = (req as AuthenticatedRequest).user?.id;

    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const secret = await repo.findOne({
      where: { projectId: req.params.projectId, environmentId: environmentId || null, key, isActive: true },
    });
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    const masterKey = MASTER_KEY();
    if (!masterKey) return res.status(500).json({ error: 'SECRETS_ENCRYPTION_KEY not configured' });

    let decrypted: string;
    try {
      decrypted = decryptValue(secret.encryptedValue, masterKey);
    } catch {
      return res.status(500).json({ error: 'Failed to decrypt secret' });
    }

    logAudit({ userId, action: 'secrets.reveal', targetType: 'Secret', targetId: secret.id, metadata: { key, environmentId } });

    return res.json({ id: secret.id, key: secret.key, value: decrypted, environmentId: secret.environmentId, version: secret.version });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Create or update a secret
router.post('/projects/:projectId/secrets', expressAuthenticate, requirePermission('secrets.create'), async (req: Request, res: Response) => {
  try {
    const { key, value, environmentId } = req.body;
    const userId = (req as AuthenticatedRequest).user?.id;
    const projectId = req.params.projectId;

    if (!key || value === undefined || value === null) {
      return res.status(400).json({ error: 'key and value are required' });
    }

    const masterKey = MASTER_KEY();
    if (!masterKey) return res.status(500).json({ error: 'SECRETS_ENCRYPTION_KEY not configured' });

    const encrypted = encryptValue(String(value), masterKey);

    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const versionRepo = ds.getRepository(SecretVersion);

    let secret = await repo.findOne({
      where: { projectId, environmentId: environmentId || null, key, isActive: true },
    });

    if (secret) {
      // Store previous version
      const prevVersion = versionRepo.create({
        secretId: secret.id,
        encryptedValue: secret.encryptedValue,
        version: secret.version,
        changedById: userId,
      });
      await versionRepo.save(prevVersion);

      secret.encryptedValue = encrypted;
      secret.version += 1;
      secret.createdById = userId;
      await repo.save(secret);
    } else {
      secret = repo.create({
        projectId,
        key,
        encryptedValue: encrypted,
        environmentId: environmentId || null,
        version: 1,
        createdById: userId,
      });
      await repo.save(secret);
    }

    logAudit({ userId, action: secret.version === 1 ? 'secrets.create' : 'secrets.update', targetType: 'Secret', targetId: secret.id, metadata: { key, environmentId, version: secret.version } });

    return res.status(201).json({ id: secret.id, key: secret.key, environmentId: secret.environmentId, version: secret.version });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Delete a secret
router.delete('/projects/:projectId/secrets/:secretId', expressAuthenticate, requirePermission('secrets.delete'), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.id;
    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const secret = await repo.findOne({
      where: { id: req.params.secretId, projectId: req.params.projectId, isActive: true },
    });
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    secret.isActive = false;
    await repo.save(secret);

    logAudit({ userId, action: 'secrets.delete', targetType: 'Secret', targetId: secret.id, metadata: { key: secret.key, environmentId: secret.environmentId } });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Export secrets as .env format
router.get('/projects/:projectId/secrets/export/:environmentId', expressAuthenticate, requirePermission('secrets.export'), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.id;
    const masterKey = MASTER_KEY();
    if (!masterKey) return res.status(500).json({ error: 'SECRETS_ENCRYPTION_KEY not configured' });

    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const secrets = await repo.find({
      where: { projectId: req.params.projectId, environmentId: req.params.environmentId, isActive: true },
    });

    const lines: string[] = [];
    for (const s of secrets) {
      try {
        const val = decryptValue(s.encryptedValue, masterKey);
        lines.push(`${s.key}=${val}`);
      } catch {}
    }

    logAudit({ userId, action: 'secrets.export', targetType: 'Project', targetId: req.params.projectId, metadata: { environmentId: req.params.environmentId, count: lines.length } });

    return res.json({ environmentId: req.params.environmentId, secrets: lines.join('\n') });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Bulk import secrets
router.post('/projects/:projectId/secrets/bulk', expressAuthenticate, requirePermission('secrets.import'), async (req: Request, res: Response) => {
  try {
    const { environmentId, secrets: secretList } = req.body;
    const userId = (req as AuthenticatedRequest).user?.id;
    const projectId = req.params.projectId;

    if (!Array.isArray(secretList) || secretList.length === 0) {
      return res.status(400).json({ error: 'secrets must be a non-empty array of {key, value}' });
    }

    const masterKey = MASTER_KEY();
    if (!masterKey) return res.status(500).json({ error: 'SECRETS_ENCRYPTION_KEY not configured' });

    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const versionRepo = ds.getRepository(SecretVersion);

    const results: { key: string; status: string; version: number }[] = [];

    for (const item of secretList) {
      if (!item.key || item.value === undefined) continue;
      const encrypted = encryptValue(String(item.value), masterKey);

      let secret = await repo.findOne({
        where: { projectId, environmentId: environmentId || null, key: item.key, isActive: true },
      });

      if (secret) {
        const prevVersion = versionRepo.create({
          secretId: secret.id,
          encryptedValue: secret.encryptedValue,
          version: secret.version,
          changedById: userId,
        });
        await versionRepo.save(prevVersion);

        secret.encryptedValue = encrypted;
        secret.version += 1;
        secret.createdById = userId;
        await repo.save(secret);
        results.push({ key: item.key, status: 'updated', version: secret.version });
      } else {
        secret = repo.create({
          projectId,
          key: item.key,
          encryptedValue: encrypted,
          environmentId: environmentId || null,
          version: 1,
          createdById: userId,
        });
        await repo.save(secret);
        results.push({ key: item.key, status: 'created', version: 1 });
      }
    }

    logAudit({ userId, action: 'secrets.import', targetType: 'Project', targetId: projectId, metadata: { environmentId, count: results.length } });

    return res.status(201).json({ imported: results.length, results });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Get version history for a secret
router.get('/projects/:projectId/secrets/:secretId/versions', expressAuthenticate, requirePermission('secrets.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const secretRepo = ds.getRepository(Secret);
    const versionRepo = ds.getRepository(SecretVersion);

    const secret = await secretRepo.findOne({
      where: { id: req.params.secretId, projectId: req.params.projectId },
    });
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    const versions = await versionRepo.find({
      where: { secretId: secret.id },
      order: { version: 'DESC' },
    });

    return res.json({
      key: secret.key,
      currentVersion: secret.version,
      history: versions.map(v => ({
        version: v.version,
        changedById: v.changedById,
        changedAt: v.createdAt,
      })),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Rollback secret to a previous version
router.post('/projects/:projectId/secrets/:secretId/rollback/:version', expressAuthenticate, requirePermission('secrets.rollback'), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.id;
    const targetVersion = parseInt(req.params.version, 10);

    if (isNaN(targetVersion) || targetVersion < 1) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    const ds = await getDb();
    const secretRepo = ds.getRepository(Secret);
    const versionRepo = ds.getRepository(SecretVersion);

    const secret = await secretRepo.findOne({
      where: { id: req.params.secretId, projectId: req.params.projectId, isActive: true },
    });
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    if (targetVersion >= secret.version) {
      return res.status(400).json({ error: `Version ${targetVersion} is not a previous version (current: ${secret.version})` });
    }

    const oldVersion = await versionRepo.findOne({
      where: { secretId: secret.id, version: targetVersion },
    });
    if (!oldVersion) return res.status(404).json({ error: `Version ${targetVersion} not found in history` });

    // Store current as history before rolling back
    const currVersion = versionRepo.create({
      secretId: secret.id,
      encryptedValue: secret.encryptedValue,
      version: secret.version,
      changedById: userId,
    });
    await versionRepo.save(currVersion);

    secret.encryptedValue = oldVersion.encryptedValue;
    secret.version += 1;
    await secretRepo.save(secret);

    logAudit({ userId, action: 'secrets.rollback', targetType: 'Secret', targetId: secret.id, metadata: { key: secret.key, rolledBackTo: targetVersion, newVersion: secret.version } });

    return res.json({ success: true, key: secret.key, version: secret.version, rolledBackTo: targetVersion });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
