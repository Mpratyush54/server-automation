import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { SmtpConfig } from '../entities/SmtpConfig';
import { StorageProvider } from '../entities/StorageProvider';
import { Project } from '../entities/Project';
import { User, UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/settings/smtp', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const configs = await ds.getRepository(SmtpConfig).find();
    return res.json(configs.map(c => ({ ...c, password: c.password ? '***' : null, apiKey: c.apiKey ? '***' : null })));
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/smtp', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(SmtpConfig);
    if (req.body.isDefault) await repo.update({ isDefault: true }, { isDefault: false });
    const config = repo.create(req.body);
    const saved = (await repo.save(config)) as unknown as SmtpConfig;
    return res.status(201).json({ ...saved, password: saved.password ? '***' : null, apiKey: saved.apiKey ? '***' : null });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/smtp/:id/test', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const config = await ds.getRepository(SmtpConfig).findOne({ where: { id: req.params.id } });
    if (!config) return res.status(404).json({ error: 'SMTP config not found' });
    const { testSmtpConnection } = await import('../lib/smtp-service');
    const result = await testSmtpConnection(config as any, req.body.testTo || config.fromEmail);
    return res.json(result);
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.delete('/settings/smtp/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    await ds.getRepository(SmtpConfig).delete(req.params.id);
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.get('/settings/storage', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const providers = await ds.getRepository(StorageProvider).find();
    return res.json(providers.map(p => ({ ...p, credentials: p.credentials ? { ...p.credentials, secretAccessKey: '***', refreshToken: '***', password: '***' } : null })));
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/storage', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(StorageProvider);
    if (req.body.isDefault) await repo.update({ isDefault: true }, { isDefault: false });
    const provider = repo.create(req.body);
    const saved = await repo.save(provider);
    return res.status(201).json(saved);
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/storage/:id/test', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const provider = await ds.getRepository(StorageProvider).findOne({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    const { createAdapter } = await import('../lib/storage-service');
    const adapter = createAdapter(
      provider.providerType,
      provider.credentials || {},
      provider.bucketName || undefined,
      provider.endpointUrl || undefined
    );
    const ok = await adapter.testConnection();
    return res.json({ success: ok, message: ok ? 'Connection successful' : 'Connection failed' });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.patch('/settings/storage/:id/set-default', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    await ds.getRepository(StorageProvider).update({}, { isDefault: false });
    await ds.getRepository(StorageProvider).update(req.params.id, { isDefault: true });
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.delete('/settings/storage/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    await ds.getRepository(StorageProvider).delete(req.params.id);
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/projects/:projectId/databases/backup', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { dbName, environment } = req.body;
    if (!dbName) return res.status(400).json({ error: 'dbName is required' });
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Get active storage provider
    const storageRepo = ds.getRepository(StorageProvider);
    const activeProvider = await storageRepo.findOne({ where: { isDefault: true } });

    const { DbBackup, BackupStatus } = await import('../entities/DbBackup');
    const backupRepo = ds.getRepository(DbBackup);
    const backup = backupRepo.create({
      projectId: project.id,
      dbName,
      environment: environment || 'production',
      providerType: (activeProvider?.providerType as any) || 'local',
      status: BackupStatus.IN_PROGRESS,
    });
    const savedBackup = await backupRepo.save(backup);

    // Trigger backup async
    (async () => {
      const tmpFile = require('path').join(process.cwd(), 'tmp', `${dbName}_${Date.now()}.dump`);
      require('fs').mkdirSync(require('path').dirname(tmpFile), { recursive: true });
      try {
        const { dumpDatabase, computeFileChecksum } = await import('../lib/database-service');
        const result = await dumpDatabase(dbName, tmpFile);
        if (!result.success) throw new Error(result.error || 'pg_dump failed');

        const checksum = await computeFileChecksum(tmpFile);
        let fileId = `backups/${project.name}/${dbName}/${require('path').basename(tmpFile)}`;

        if (activeProvider) {
          const { createAdapter } = await import('../lib/storage-service');
          const adapter = createAdapter(activeProvider.providerType, activeProvider.credentials || {}, activeProvider.bucketName || undefined, activeProvider.endpointUrl || undefined);
          const uploadResult = await adapter.upload(tmpFile, fileId);
          fileId = uploadResult.fileId;
        }

        const bkpDs = await getDb();
        await bkpDs.getRepository(DbBackup).update(savedBackup.id, {
          status: BackupStatus.COMPLETED,
          fileId,
          fileSizeBytes: result.sizeBytes,
          checksum,
        });

        // SMTP notification
        try {
          const smtpCfg = await bkpDs.getRepository(SmtpConfig).findOne({ where: { isDefault: true } });
          if (smtpCfg) {
            const { sendMail, buildBackupEmail } = await import('../lib/smtp-service');
            const devopsUsers = await bkpDs.getRepository(User).find({ where: { role: UserRole.DEVOPS } });
            const to = devopsUsers.map((u: any) => u.email).filter(Boolean);
            if (to.length > 0) {
              const html = buildBackupEmail({ projectName: project.name, dbName, environment: environment || 'production', fileSize: result.sizeBytes, provider: activeProvider?.providerType || 'local', status: 'completed' });
              await sendMail(smtpCfg as any, to, `[${project.name}] Database Backup Completed`, html);
            }
          }
        } catch {}

        try { require('fs').unlinkSync(tmpFile); } catch {}
      } catch (err: any) {
        const bkpDs = await getDb();
        await bkpDs.getRepository(DbBackup).update(savedBackup.id, { status: BackupStatus.FAILED, errorMessage: err.message });
      }
    })();

    await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'database.backup.triggered', targetType: 'Project', targetId: project.id, metadata: { dbName, environment }, ip: req.ip });
    return res.status(202).json({ backupId: savedBackup.id, status: 'in_progress', message: 'Backup started. You will be notified when complete.' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/projects/:projectId/databases/backups', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { dbName } = req.query as Record<string, string>;
    const ds = await getDb();
    const { DbBackup } = await import('../entities/DbBackup');
    const where: any = { projectId: req.params.projectId };
    if (dbName) where.dbName = dbName;
    const backups = await ds.getRepository(DbBackup).find({ where, order: { createdAt: 'DESC' }, take: 50 });
    return res.json(backups);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/projects/:projectId/databases/backups/:backupId/restore', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const { DbBackup, BackupStatus } = await import('../entities/DbBackup');
    const backup = await ds.getRepository(DbBackup).findOne({ where: { id: req.params.backupId, projectId: req.params.projectId } });
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    if (backup.status !== BackupStatus.COMPLETED) return res.status(400).json({ error: 'Backup is not in completed state' });

    await ds.getRepository(DbBackup).update(backup.id, { status: BackupStatus.RESTORING });

    // Async restore
    (async () => {
      const tmpFile = require('path').join(process.cwd(), 'tmp', `restore_${backup.dbName}_${Date.now()}.dump`);
      require('fs').mkdirSync(require('path').dirname(tmpFile), { recursive: true });
      try {
        const restoreDs = await getDb();
        if (backup.fileId) {
          const storageRepo = restoreDs.getRepository(StorageProvider);
          const activeProvider = await storageRepo.findOne({ where: { isDefault: true } });
          if (activeProvider) {
            const { createAdapter } = await import('../lib/storage-service');
            const adapter = createAdapter(activeProvider.providerType, activeProvider.credentials || {}, activeProvider.bucketName || undefined, activeProvider.endpointUrl || undefined);
            await adapter.download(backup.fileId, tmpFile);
          }
        }
        const { restoreDatabase } = await import('../lib/database-service');
        const result = await restoreDatabase(backup.dbName, tmpFile);
        if (!result.success) throw new Error(result.error || 'pg_restore failed');

        await restoreDs.getRepository(DbBackup).update(backup.id, { status: BackupStatus.COMPLETED, restoredAt: new Date() });
        try { require('fs').unlinkSync(tmpFile); } catch {}
      } catch (err: any) {
        const errDs = await getDb();
        await errDs.getRepository(DbBackup).update(backup.id, { status: BackupStatus.FAILED, errorMessage: err.message });
      }
    })();

    await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'database.restore.triggered', targetType: 'Project', targetId: req.params.projectId, metadata: { backupId: backup.id, dbName: backup.dbName }, ip: req.ip });
    return res.status(202).json({ message: 'Restore started', backupId: backup.id });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
