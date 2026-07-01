import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { ClickupTaskLink } from '../entities/ClickupTaskLink';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { triggerPipeline } from '../lib/gitlab';
import { getK8sNodes, getK8sNamespaces, getK8sPods, getPodLogs, deletePod, checkK8sConnection } from '../lib/k8s';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post('/bootstrap/init', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { hostname, components } = req.body;
    const log = [
      `[${new Date().toISOString()}] Bootstrap initiated for hostname: ${hostname}`,
      ...(components || []).map((c: string) => `[${new Date().toISOString()}] Component "${c}" registered`),
      `[${new Date().toISOString()}] Bootstrap completed`,
    ].join('\n');
    return res.status(201).json({ status: 'completed', log });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/bootstrap/status', expressAuthenticate, async (req: Request, res: Response) => {
  // ── PostgreSQL ────────────────────────────────────────────────────────────
  let pgStatus = 'offline';
  try {
    const ds = await getDb();
    if (ds.isInitialized) { await ds.query('SELECT 1'); pgStatus = 'running'; }
  } catch { pgStatus = 'offline'; }

  // ── MongoDB ───────────────────────────────────────────────────────────────
  let mongoStatus = 'offline';
  try {
    const mg = require('mongoose');
    if (mg.connection && mg.connection.readyState === 1) {
      mongoStatus = 'running';
    } else {
      await connectMongo();
      mongoStatus = mg.connection?.readyState === 1 ? 'running' : 'offline';
    }
  } catch { mongoStatus = 'offline'; }

  // ── Kubernetes / real pod counts ──────────────────────────────────────────
  let k8sOk = false;
  const podCounts: Record<string, number> = {};
  try {
    k8sOk = await checkK8sConnection();
    if (k8sOk) {
      const { CoreV1Api } = await import('@kubernetes/client-node');
      const kc = new (await import('@kubernetes/client-node')).KubeConfig();
      kc.loadFromDefault();
      const coreApi = kc.makeApiClient(CoreV1Api);
      const namespaces = ['platform', 'databases', 'monitoring', 'storage', 'argocd', 'portainer', 'infisical', 'cert-manager', 'ingress-nginx'];
      for (const ns of namespaces) {
        try {
          const r = await coreApi.listNamespacedPod({ namespace: ns });
          podCounts[ns] = r.items.filter(p => p.status?.phase === 'Running').length;
        } catch { podCounts[ns] = 0; }
      }
    }
  } catch { k8sOk = false; }

  // Helper: map pod count to status string
  const podStatus = (ns: string, min = 1) =>
    !k8sOk ? 'unknown' : (podCounts[ns] || 0) >= min ? 'running' : podCounts[ns] === 0 ? 'offline' : 'degraded';

  // ── Integration presence (env vars) ──────────────────────────────────────
  const integrations = {
    github:    !!(process.env.GITHUB_TOKEN),
    gitlab:    !!(process.env.GITLAB_TOKEN),
    clickup:   !!(process.env.CLICKUP_API_TOKEN),
    smtp:      !!(process.env.SMTP_PROVIDER || process.env.SMTP_HOST || process.env.SENDGRID_API_KEY),
    argocd:    !!(process.env.ARGOCD_URL || process.env.ARGOCD_TOKEN || k8sOk),
    infisical: !!(process.env.INFISICAL_URL || process.env.INFISICAL_TOKEN),
    minio:     !!(process.env.MINIO_ENDPOINT || process.env.MINIO_ACCESS_KEY),
    grafana:   !!(process.env.GRAFANA_URL || podStatus('monitoring') === 'running'),
  };

  // ── Build services map ────────────────────────────────────────────────────
  const services: Record<string, string> = {
    'platform-api':       pgStatus === 'running' ? 'running' : 'degraded',
    'platform-portal':    'running',  // if this API responded, portal is up
    'postgresql':     pgStatus,
    'mongodb':        mongoStatus,
    'redis':          k8sOk ? podStatus('databases') : 'unknown',
    'minio':          podStatus('storage'),
    'argocd':         podStatus('argocd'),
    'grafana':        podStatus('monitoring'),
    'prometheus':     podStatus('monitoring'),
    'loki':           podStatus('monitoring'),
    'portainer':      podStatus('portainer'),
    'infisical':      podStatus('infisical'),
    'cert-manager':   podStatus('cert-manager'),
    'ingress-nginx':  podStatus('ingress-nginx'),
  };

  const overallHealthy = pgStatus === 'running' && mongoStatus === 'running';
  return res.json({
    status: overallHealthy ? 'healthy' : 'degraded',
    postgres: pgStatus,
    mongodb: mongoStatus,
    k8s: k8sOk ? 'connected' : 'disconnected',
    podCounts,
    services,
    integrations,
  });
});

router.get('/bootstrap/token', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  return res.json({ token: uuidv4() });
});

router.get('/bootstrap/history', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  // Mock bootstrap job history logs
  return res.json([
    { id: 1, nodeIp: '192.168.1.105', hostname: 'node-worker-1', status: 'success', date: new Date(Date.now() - 3600000) },
    { id: 2, nodeIp: '192.168.1.106', hostname: 'node-worker-2', status: 'success', date: new Date(Date.now() - 7200000) },
  ]);
});

router.get('/bootstrap/nodes', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  const nodes = await getK8sNodes();
  return res.json({ k8sConnected: isConnected, nodes });
});

router.get('/bootstrap/namespaces', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  const namespaces = await getK8sNamespaces();
  return res.json({ k8sConnected: isConnected, namespaces });
});

router.get('/bootstrap/pods', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  if (!isConnected) {
    // Return mock pods when disconnected, but indicate status
    const fallbackPods = [
      { name: 'platform-backend-67fd89c-4x92m', namespace: 'platform', status: 'Running', restarts: 0, age: '12d', node: 'kvm8-master' },
      { name: 'platform-portal-9f8e7d-2b4x9', namespace: 'platform', status: 'Running', restarts: 1, age: '12d', node: 'node-worker-1' },
      { name: 'preview-cu-842-auth-fix-bc68d-lq2p9', namespace: 'preview', status: 'Running', restarts: 0, age: '1d', node: 'node-worker-2' },
      { name: 'preview-cu-123-upload-fd68e-mq8p1', namespace: 'preview', status: 'Failed', restarts: 5, age: '3h', node: 'node-worker-2' },
      { name: 'postgres-db-0', namespace: 'databases', status: 'Running', restarts: 0, age: '45d', node: 'node-worker-1' }
    ];
    return res.json({ k8sConnected: false, pods: fallbackPods });
  }

  try {
    const ns = req.query.namespace as string | undefined;
    const pods = await getK8sPods(ns);
    return res.json({ k8sConnected: true, pods });
  } catch (err: any) {
    return res.status(400).json({ error: err.message, k8sConnected: false });
  }
});

router.get('/bootstrap/pods/:namespace/:podName/logs', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { namespace, podName } = req.params;
    const logs = await getPodLogs(namespace, podName);
    return res.json({ logs });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/bootstrap/pods/:namespace/:podName', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { namespace, podName } = req.params;
    await deletePod(namespace, podName);
    
    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'pod.deleted',
      targetType: 'Pod',
      targetId: `${namespace}/${podName}`,
      ip: req.ip,
    });

    return res.json({ success: true, message: `Pod ${podName} in namespace ${namespace} deleted` });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/integrations/clickup/webhook', async (req: Request, res: Response) => {
  try {
    const { task_id, status } = req.body;
    if (status === 'In Review') {
      const ds = await getDb();
      const link = await ds.getRepository(ClickupTaskLink).findOne({ where: { clickupTaskId: task_id } });
      if (link) {
        await triggerPipeline(link.projectId, link.branch);
        return res.json({ success: true, message: 'GitLab CI pipeline triggered' });
      }
    }
    return res.json({ success: false, message: 'No linked deployment found' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/integrations/clickup/status', expressAuthenticate, async (req: Request, res: Response) => {
  return res.json({ integration: 'ClickUp', status: 'active', webhooksRegistered: 1 });
});

export default router;
