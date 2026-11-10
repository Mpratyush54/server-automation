import * as crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import mongoose from 'mongoose';
import { connectMongo } from '../config/mongoose';
import { ClickupTaskLink } from '../entities/ClickupTaskLink';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, requireAgentScopeOrRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { triggerPipeline } from '../lib/gitlab';
import { getK8sNodes, getK8sNamespaces, getK8sPods, getPodLogs, deletePod, checkK8sConnection } from '../lib/k8s';
import { v4 as uuidv4 } from 'uuid';
import { withTimeout } from '../lib/with-timeout';
import { resolveIntegrations } from '../lib/integrations';

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

const PROBE_TIMEOUT_MS = Number(process.env.STATUS_PROBE_TIMEOUT_MS) || 2500;

router.get('/bootstrap/status', expressAuthenticate, async (req: Request, res: Response) => {
  const probePostgres = async (): Promise<string> => {
    const ds = await getDb();
    if (!ds.isInitialized) return 'offline';
    await ds.query('SELECT 1');
    return 'running';
  };

  const probeMongo = async (): Promise<string> => {
    // A function, not an inline check: readyState changes across the await.
    const connected = () => Number(mongoose.connection?.readyState) === 1;
    if (connected()) return 'running';
    await connectMongo();
    return connected() ? 'running' : 'offline';
  };

  // Real pod counts per namespace, fetched in parallel.
  const probeK8s = async (): Promise<{ ok: boolean; podCounts: Record<string, number> }> => {
    const podCounts: Record<string, number> = {};
    if (!(await checkK8sConnection())) return { ok: false, podCounts };
    // Reuse lib/k8s's shared client: loading @kubernetes/client-node and
    // building a KubeConfig inside the request was slow and synchronous.
    const namespaces = ['platform', 'databases', 'monitoring', 'storage', 'argocd', 'portainer', 'cert-manager', 'ingress-nginx'];
    await Promise.all(namespaces.map(async (ns) => {
      try {
        const pods = await getK8sPods(ns);
        podCounts[ns] = pods.filter((p: any) => p.status === 'Running').length;
      } catch { podCounts[ns] = 0; }
    }));
    return { ok: true, podCounts };
  };

  // Saved integration settings live in the same Postgres the probe uses.
  // Statically imported: a request-time import() compiles the module on first
  // use, which blocks the event loop (and these timeouts) on a cold start.
  const probeIntegrations = () => resolveIntegrations();

  // Every lookup runs concurrently and each is bounded, so the endpoint
  // answers within ~PROBE_TIMEOUT_MS even when every dependency is down.
  const [pgStatus, mongoStatus, k8s, cfg] = await Promise.all([
    withTimeout(probePostgres(), PROBE_TIMEOUT_MS, 'offline'),
    withTimeout(probeMongo(), PROBE_TIMEOUT_MS, 'offline'),
    withTimeout(probeK8s(), PROBE_TIMEOUT_MS, { ok: false, podCounts: {} as Record<string, number> }),
    withTimeout(probeIntegrations(), PROBE_TIMEOUT_MS, null),
  ]);
  const k8sOk = k8s.ok;
  const podCounts = k8s.podCounts;

  // Helper: map pod count to status string
  const podStatus = (ns: string, min = 1) =>
    !k8sOk ? 'unknown' : (podCounts[ns] || 0) >= min ? 'running' : podCounts[ns] === 0 ? 'offline' : 'degraded';

  // ── Integration presence (saved settings, then env vars) ─────────────────
  // A connected GitHub App / GitLab application (#35) counts as configured.
  const githubOk = Boolean(cfg?.githubToken ?? process.env.GITHUB_TOKEN) || cfg?.githubSource === 'app';
  const gitlabOk = Boolean(cfg?.gitlabToken ?? process.env.GITLAB_TOKEN) || cfg?.gitlabSource === 'app';
  const clickupOk = Boolean(cfg?.clickupToken ?? process.env.CLICKUP_API_TOKEN);

  const integrations = {
    github:    githubOk,
    gitlab:    gitlabOk,
    clickup:   clickupOk,
    smtp:      !!(process.env.SMTP_PROVIDER || process.env.SMTP_HOST || process.env.SENDGRID_API_KEY),
    argocd:    !!(process.env.ARGOCD_URL || process.env.ARGOCD_TOKEN || k8sOk),
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
    'cert-manager':   podStatus('cert-manager'),
    'ingress-nginx':  podStatus('ingress-nginx'),
  };

  const overallHealthy = pgStatus === 'running' && mongoStatus === 'running';
  return res.json({
    platformName: process.env.PLATFORM_NAME?.trim() || process.env.DOMAIN?.trim() || null,
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

router.get('/bootstrap/nodes', expressAuthenticate, requireAgentScopeOrRole(['cluster:read', 'bootstrap:read'], [UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  const nodes = await getK8sNodes();
  return res.json({ k8sConnected: isConnected, nodes });
});

router.get('/bootstrap/namespaces', expressAuthenticate, requireAgentScopeOrRole(['cluster:read', 'bootstrap:read'], [UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  const namespaces = await getK8sNamespaces();
  return res.json({ k8sConnected: isConnected, namespaces });
});

router.get('/bootstrap/pods', expressAuthenticate, requireAgentScopeOrRole(['cluster:read', 'bootstrap:read'], [UserRole.DEVOPS]), async (req: Request, res: Response) => {
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

router.get('/bootstrap/pods/:namespace/:podName/logs', expressAuthenticate, requireAgentScopeOrRole(['cluster:read', 'bootstrap:read', 'logs:read'], [UserRole.DEVOPS]), async (req: Request, res: Response) => {
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
    const secret = process.env.CLICKUP_WEBHOOK_SECRET;
    const signature = req.get('x-signature');
    const raw = (req as any).rawBody;
    if (!secret || !Buffer.isBuffer(raw) || !signature || !/^[a-f0-9]{64}$/.test(signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

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
