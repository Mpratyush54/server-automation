import { Router } from 'express';
import * as k8s from '@kubernetes/client-node';
import { expressAuthenticate, expressRequireRole } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { parseBackupStatus, backupMetrics } from '../lib/backup-status';

const router = Router();
async function statuses() {
  const kc = new k8s.KubeConfig();
  try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  const client = kc.makeApiClient(k8s.CoreV1Api);
  return Promise.all(['backup', 'restore-test'].map(async operation => {
    try {
      const cm = await client.readNamespacedConfigMap({ namespace: 'platform', name: `platform-backup-${operation}` });
      return { operation, status: parseBackupStatus(cm.data?.['status.json'] || '') };
    } catch (err: any) {
      if (err.code === 404 || err.response?.statusCode === 404) return { operation, status: null };
      throw err;
    }
  }));
}
router.get('/settings/backups', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (_req, res) => {
  try { return res.json({ items: await statuses() }); }
  catch { return res.status(503).json({ error: 'Backup status unavailable' }); }
});
router.get('/settings/backups/metrics', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (_req, res) => {
  try {
    const items = await statuses();
    return res.type('text/plain; version=0.0.4').send(items.map(i => i.status ? backupMetrics(i.operation, i.status) : '').join(''));
  } catch { return res.status(503).send('Backup status unavailable'); }
});
export default router;
