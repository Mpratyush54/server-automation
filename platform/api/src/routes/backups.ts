import { Router } from 'express';
import * as k8s from '@kubernetes/client-node';
import { expressAuthenticate, expressRequireRole } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { parseBackupStatus, backupMetrics, parseBackupStorage, postgresRecovery, backupOverview, ArchiverRow } from '../lib/backup-status';
import { loadKubeConfig } from '../lib/kube-config';
import { AppDataSource } from '../config/database';

const router = Router();

function kubeConfig() {
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  return kc;
}

const notFound = (err: any) => err?.code === 404 || err?.response?.statusCode === 404 || err?.statusCode === 404;

async function statuses(kc = kubeConfig()) {
  const client = kc.makeApiClient(k8s.CoreV1Api);
  return Promise.all(['backup', 'restore-test'].map(async operation => {
    try {
      const cm = await client.readNamespacedConfigMap({ namespace: 'platform', name: `platform-backup-${operation}` });
      return { operation, status: parseBackupStatus(cm.data?.['status.json'] || '') };
    } catch (err: any) {
      if (notFound(err)) return { operation, status: null };
      throw err;
    }
  }));
}

/** Non-secret target summary written by platformctl (#186). */
async function storageSummary(kc: k8s.KubeConfig) {
  try {
    const cm = await kc.makeApiClient(k8s.CoreV1Api).readNamespacedConfigMap({ namespace: 'platform', name: 'platform-backup-target' });
    return parseBackupStorage(cm.data);
  } catch {
    return parseBackupStorage(null);
  }
}

async function customObject(kc: k8s.KubeConfig, group: string, version: string, plural: string, name: string): Promise<any | null> {
  try {
    return await kc.makeApiClient(k8s.CustomObjectsApi).getNamespacedCustomObject({ group, version, namespace: 'databases', plural, name });
  } catch {
    return null;
  }
}

async function archiver(): Promise<ArchiverRow | null> {
  try {
    const rows = await AppDataSource.query('SELECT last_archived_time, last_failed_time FROM pg_stat_archiver');
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

async function postgres(kc: k8s.KubeConfig) {
  const cluster = await customObject(kc, 'postgresql.cnpg.io', 'v1', 'clusters', 'postgresql');
  if (!cluster) return postgresRecovery(null, null, null);
  const [store, row] = await Promise.all([customObject(kc, 'barmancloud.cnpg.io', 'v1', 'objectstores', 'postgresql-backup'), archiver()]);
  return postgresRecovery(cluster, store, row);
}

router.get('/settings/backups', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (_req, res) => {
  try {
    const kc = kubeConfig();
    const [items, storage, pg] = await Promise.all([statuses(kc), storageSummary(kc), postgres(kc)]);
    return res.json(backupOverview(items, storage, pg));
  } catch { return res.status(503).json({ error: 'Backup status unavailable' }); }
});
router.get('/settings/backups/metrics', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (_req, res) => {
  try {
    const items = await statuses();
    return res.type('text/plain; version=0.0.4').send(items.map(i => i.status ? backupMetrics(i.operation, i.status) : '').join(''));
  } catch { return res.status(503).send('Backup status unavailable'); }
});
export default router;
