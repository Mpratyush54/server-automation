import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { Project } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';
import { decryptValue } from '../lib/secrets-encryption';
import { FeatureFlagModel } from '../schemas/FeatureFlag';

const router = Router();

router.get('/config', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    let { projectId, environmentId } = req.query as Record<string, string>;
    const ds = await getDb();
    
    // Resolve environment name to UUID if needed
    if (environmentId && !environmentId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      const envRepo = ds.getRepository(Environment);
      const env = await envRepo.findOne({ where: { name: environmentId as any, projectId } });
      if (env) environmentId = env.id;
    }
    // Resolve project name to UUID if needed
    if (projectId && !projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      const projRepo = ds.getRepository(Project);
      const proj = await projRepo.findOne({ where: { name: projectId } });
      if (proj) projectId = proj.id;
    }

    const configRepo = ds.getRepository(ProjectConfig);
    const configs = await configRepo.find({ where: { projectId } });
    const result: Record<string, string> = {};
    for (const c of configs) {
      if (c.environmentId && environmentId && c.environmentId !== environmentId) continue;
      result[c.key] = c.isSecret ? '***' : c.value;
    }

    // Include decrypted secrets from the Secret entity
    const secretRepo = ds.getRepository(Secret);
    const secrets = await secretRepo.find({ where: { isActive: true, projectId } });
    const masterKey = process.env.SECRETS_ENCRYPTION_KEY;
    if (masterKey) {
      for (const s of secrets) {
        try {
          result[s.key] = decryptValue(s.encryptedValue, masterKey);
        } catch {}
      }
    }

    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/config', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(ProjectConfig);

    let config = await repo.findOne({
      where: { projectId: body.projectId, key: body.key, environmentId: body.environmentId || null },
    });

    if (config) {
      config.value = body.value;
      config.isSecret = body.isSecret || false;
      config.changedById = (req as AuthenticatedRequest).user?.id || null;
      await repo.save(config);
    } else {
      config = repo.create({
        projectId: body.projectId,
        key: body.key,
        value: body.value,
        environmentId: body.environmentId || null,
        isSecret: body.isSecret || false,
        changedById: (req as AuthenticatedRequest).user?.id || null,
      });
      await repo.save(config);
    }

    return res.status(201).json(config);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/config', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { projectId, key, environmentId } = req.query as Record<string, string>;
    const ds = await getDb();
    const repo = ds.getRepository(ProjectConfig);
    const config = await repo.findOne({
      where: { projectId, key, environmentId: environmentId || null },
    });
    if (!config) {
      return res.status(404).json({ error: 'Config not found' });
    }
    await repo.remove(config);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/config/feature-flags', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    await connectMongo();
    const flag = await FeatureFlagModel.findOneAndUpdate(
      { projectId: body.projectId, environmentId: body.environmentId, key: body.key },
      { $set: { value: body.value, isEnabled: body.isEnabled !== false } },
      { upsert: true, new: true }
    );
    return res.status(201).json(flag);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
