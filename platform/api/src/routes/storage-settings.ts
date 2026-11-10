import { Router, RequestHandler } from 'express';
import { getDb } from '../config/database';
import { StorageProvider } from '../entities/StorageProvider';
import { UserRole } from '../entities/User';
import { File } from '../entities/File';
import { DbBackup } from '../entities/DbBackup';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { publicStorageProvider } from '../lib/storage-credentials';
import { storagePreset } from '../lib/storage-presets';
import { BUNDLED_STORAGE_ID, checkStorageProvider, withStorageLock } from '../lib/storage-providers';
import { createOperation, publicOperation, runOperation } from '../lib/operations';
import '../lib/storage-migrate-op';

const router = Router();
const safe = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Storage request failed' });
  });
};
router.use('/settings/storage', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]));
router.get('/settings/storage', safe(async (_req, res) => {
  try { return res.json((await (await getDb()).getRepository(StorageProvider).find()).map(publicStorageProvider)); }
  catch { return res.status(500).json({ error: 'Could not load storage providers' }); }
}));
router.post('/settings/storage', safe(async (req, res) => {
  try {
    const data = storagePreset(req.body || {});
    const ds = await getDb();
    const saved = await withStorageLock(ds, async em => {
      const repo = em.getRepository(StorageProvider);
      if (data.isDefault) await repo.update({ isDefault: true }, { isDefault: false });
      return repo.save(repo.create(data) as unknown as StorageProvider);
    });
    await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'storage.provider.created', targetType: 'StorageProvider', targetId: saved.id, ip: req.ip });
    return res.status(201).json(publicStorageProvider(saved));
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
}));
router.post('/settings/storage/:id/test', safe(async (req, res) => {
  const p = await (await getDb()).getRepository(StorageProvider).findOne({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const result = await checkStorageProvider(p);
  await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'storage.provider.tested', targetType: 'StorageProvider', targetId: p.id, ip: req.ip });
  return res.json(result);
}));
router.patch('/settings/storage/:id/set-default', safe(async (req, res) => {
  try {
    const ds = await getDb();
    await withStorageLock(ds, async em => {
      const repo = em.getRepository(StorageProvider);
      const p = await repo.findOne({ where: { id: req.params.id } });
      if (!p) throw new Error('Provider not found');
      if (!['s3', 'minio', 'local'].includes(p.providerType)) throw new Error('Provider does not support SDK uploads');
      await repo.update({ isDefault: true }, { isDefault: false });
      await repo.update(p.id, { isDefault: true });
    });
    await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'storage.provider.default', targetType: 'StorageProvider', targetId: req.params.id, ip: req.ip });
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
}));
router.post('/settings/storage/:id/migrate-local', safe(async (req, res) => {
  try {
    const p = await (await getDb()).getRepository(StorageProvider).findOne({ where: { id: req.params.id } });
    if (!p || !['s3', 'minio'].includes(p.providerType)) return res.status(400).json({ error: 'An object storage provider is required' });
    const op = await createOperation('storage.migrate-local', { lockKey: 'lock:storage:migrate-local', input: { providerId: p.id }, createdById: (req as AuthenticatedRequest).user?.id });
    await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'storage.migration.started', targetType: 'StorageProvider', targetId: p.id, ip: req.ip });
    void runOperation(op.id).catch(() => {});
    return res.status(202).json(publicOperation(op));
  } catch { return res.status(400).json({ error: 'Could not start migration' }); }
}));
router.delete('/settings/storage/:id', safe(async (req, res) => {
  try {
    const ds = await getDb();
    await withStorageLock(ds, async em => {
      const repo = em.getRepository(StorageProvider);
      const p = await repo.findOne({ where: { id: req.params.id } });
      if (!p) throw new Error('Provider not found');
      if (p.id === BUNDLED_STORAGE_ID || p.isDefault) throw new Error('Switch the default first; bundled storage cannot be deleted');
      if (await em.getRepository(File).countBy({ storageProviderId: p.id }) || await em.getRepository(DbBackup).countBy({ providerId: p.id })) throw new Error('Provider is still referenced by files or backups');
      await repo.delete(p.id);
    });
    await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'storage.provider.deleted', targetType: 'StorageProvider', targetId: req.params.id, ip: req.ip });
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
}));
export default router;
