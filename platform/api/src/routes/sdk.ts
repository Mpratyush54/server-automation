import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { Project, StackType } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { ServiceRegistration } from '../entities/ServiceRegistration';
import { DbConnection, DbConnectionStatus, DbType } from '../entities/DbConnection';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { sdkTokenAuth, expressAuthenticate } from '../middleware/auth';
import { fetchSecrets } from '../lib/infisical';
import { decryptValue } from '../lib/secrets-encryption';
import { forwardToLoki } from '../lib/lokilog';
import { LogModel } from '../schemas/Log';
import { ErrorDocModel } from '../schemas/ErrorDoc';
import { MetricsRawModel } from '../schemas/MetricsRaw';
import { SdkEventModel } from '../schemas/SdkEvent';
import { BugReportModel } from '../schemas/BugReport';
import * as k8s from '@kubernetes/client-node';
import { ApiMetricModel } from '../schemas/ApiMetric';
import { postComment } from '../lib/clickup';

const router = Router();

router.post('/sdk/register', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    
    // Resolve project ID by name if needed
    const projectRepo = ds.getRepository(Project);
    let project = await projectRepo.findOne({ where: { name: body.projectName } });
    if (!project) {
      // Create project on-the-fly to facilitate local testing
      project = projectRepo.create({
        name: body.projectName,
        stack: StackType.NODEJS,
      });
      project = await projectRepo.save(project);
    }

    // Resolve environment ID by name
    const envRepo = ds.getRepository(Environment);
    let env = await envRepo.findOne({ where: { projectId: project.id, name: body.environmentName } });
    if (!env) {
      env = envRepo.create({
        name: body.environmentName as any,
        namespace: `${project.name}-${body.environmentName}`,
        domain: `${project.name}-${body.environmentName}.example.com`,
        projectId: project.id,
      });
      env = await envRepo.save(env);
    }

    const repo = ds.getRepository(ServiceRegistration);
    let registration = await repo.findOne({
      where: {
        projectId: project.id,
        environmentId: env.id,
        serviceName: body.serviceName || project.name,
      },
    });

    if (registration) {
      registration.hostname = body.hostname ?? registration.hostname;
      registration.ipAddress = body.ipAddress ?? registration.ipAddress;
      registration.version = body.version ?? registration.version;
      registration.branch = body.branch ?? registration.branch;
      registration.commitSha = body.commitSha ?? registration.commitSha;
      registration.infisicalProject = body.infisicalProject ?? registration.infisicalProject;
      registration.infisicalEnv = body.infisicalEnv ?? registration.infisicalEnv;
      registration.envKeys = body.envKeys ?? registration.envKeys;
      registration.dbTypes = body.dbTypes ?? registration.dbTypes;
      registration.metadata = body.metadata ?? registration.metadata;
      registration.lastSeen = new Date();
      registration.status = 'online';
    } else {
      registration = repo.create({
        projectId: project.id,
        environmentId: env.id,
        hostname: body.hostname || 'localhost',
        ipAddress: body.ipAddress || '127.0.0.1',
        serviceName: body.serviceName || project.name,
        version: body.version || '1.0.0',
        branch: body.branch || 'main',
        commitSha: body.commitSha || 'unknown',
        infisicalProject: body.infisicalProject || 'default',
        infisicalEnv: body.infisicalEnv || 'dev',
        envKeys: body.envKeys || [],
        dbTypes: body.dbTypes || [],
        status: 'online',
        metadata: body.metadata || {},
        lastSeen: new Date(),
      });
    }

    const saved = await repo.save(registration);

    // Ensure DB connection metrics placeholders are created in relational DB
    if (body.dbTypes && Array.isArray(body.dbTypes)) {
      const dbRepo = ds.getRepository(DbConnection);
      for (const type of body.dbTypes) {
        let conn = await dbRepo.findOne({ where: { projectId: project.id, dbType: type as DbType } });
        if (!conn) {
          conn = dbRepo.create({
            registrationId: saved.id,
            projectId: project.id,
            dbType: type as DbType,
            poolSize: 10,
            status: DbConnectionStatus.CONNECTED,
            lastHeartbeat: new Date(),
          });
          await dbRepo.save(conn);
        }
      }
    }

    await connectMongo();
    await SdkEventModel.create({
      event: 'registration',
      registrationId: saved.id,
      projectId: project.id,
      payloadSummary: { serviceName: body.serviceName, hostname: body.hostname },
      timestamp: new Date(),
    });

    // Auto-provision PostgreSQL databases if requested
    if (body.dbTypes && body.dbTypes.includes('postgres')) {
      try {
        const { provisionPostgresDb } = await import('../lib/database-service');
        const envs = ['development', 'staging', 'production'];
        for (const envName of envs) {
          await provisionPostgresDb(project.name, envName).catch(() => {});
        }
      } catch (e) {
        console.warn('[sdk/register] Failed to auto-provision databases:', (e as Error).message);
      }
    }

    // Auto-create ArgoCD Application for GitOps (staging)
    if (project.repositoryUrl) {
      try {
        const customApi = new k8s.KubeConfig();
        try { customApi.loadFromCluster(); } catch { try { customApi.loadFromDefault(); } catch {} }
        const apiClient = customApi.makeApiClient(k8s.CustomObjectsApi);
        const appName = `${project.name}-staging`.toLowerCase();
        try {
          await apiClient.getNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
            plural: 'applications', name: appName,
          });
        } catch {
          // Application doesn't exist — create it
          const domain = project.domain || process.env.DOMAIN || 'sslip.io';
          await apiClient.createNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
            plural: 'applications',
            body: {
              apiVersion: 'argoproj.io/v1alpha1',
              kind: 'Application',
              metadata: { name: appName, namespace: 'argocd' },
              spec: {
                project: 'default',
                source: { repoURL: project.repositoryUrl, targetRevision: 'main', path: 'k8s' },
                destination: { server: 'https://kubernetes.default.svc', namespace: 'platform' },
                syncPolicy: { automated: { prune: true, selfHeal: true } },
              },
            },
          });
        }
      } catch (e) {
        console.warn('[sdk/register] Failed to create ArgoCD Application:', (e as Error).message);
      }
    }

    // Auto-create K8s Deployment, Service, and Ingress for the service
    const serviceName = body.serviceName || project.name;
    try {
      const kc = new k8s.KubeConfig();
      try { kc.loadFromCluster(); } catch { try { kc.loadFromDefault(); } catch {} }
      const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
      const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
      const networkV1 = kc.makeApiClient(k8s.NetworkingV1Api);
      const ns = 'platform';
      const deployName = `${project.name}-${body.serviceName || 'app'}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Deployment
      const deployment = {
        metadata: { name: deployName, namespace: ns, labels: { app: deployName, project: project.name } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: deployName } },
          template: {
            metadata: { labels: { app: deployName, project: project.name } },
            spec: {
              containers: [{
                name: 'app',
                image: `${project.name}:latest`,
                ports: [{ containerPort: 3001 }],
              }],
            },
          },
        },
      };
      try { await appsV1.createNamespacedDeployment({ namespace: ns, body: deployment as any }); }
      catch { try { await appsV1.replaceNamespacedDeployment({ name: deployName, namespace: ns, body: deployment as any }); } catch {} }

      // Service
      const service = {
        metadata: { name: deployName, namespace: ns },
        spec: {
          selector: { app: deployName },
          ports: [{ port: 80, targetPort: 3001 }],
        },
      };
      try { await coreV1.createNamespacedService({ namespace: ns, body: service as any }); }
      catch { try { await coreV1.replaceNamespacedService({ name: deployName, namespace: ns, body: service as any }); } catch {} }

      // Ingress — only request Let's Encrypt cert for real domains, not sslip.io
      const domain = project.domain || process.env.DOMAIN || 'sslip.io';
      const isRealDomain = !domain.includes('sslip.io') && !domain.match(/^\d+\.\d+\.\d+\.\d+/);
      const ingress: any = {
        metadata: {
          name: deployName,
          namespace: ns,
          annotations: {
            'kubernetes.io/ingress.class': 'nginx',
          },
        },
        spec: {
          rules: [{
            host: `${deployName}.${domain}`,
            http: {
              paths: [{
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: deployName, port: { number: 80 } } },
              }],
            },
          }],
        },
      };
      if (isRealDomain) {
        ingress.metadata.annotations['cert-manager.io/cluster-issuer'] = 'letsencrypt-prod';
        ingress.spec.tls = [{ hosts: [`${deployName}.${domain}`], secretName: `${deployName}-tls` }];
      }
      try { await networkV1.createNamespacedIngress({ namespace: ns, body: ingress as any }); }
      catch { try { await networkV1.replaceNamespacedIngress({ name: deployName, namespace: ns, body: ingress as any }); } catch {} }
    } catch (e) {
      console.warn('[sdk/register] Failed to create K8s resources:', (e as Error).message);
    }

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/deregister', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { projectId, serviceName } = req.body;
    const ds = await getDb();
    
    // Resolve project
    const project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (project) {
      const repo = ds.getRepository(ServiceRegistration);
      const reg = await repo.findOne({ where: { projectId: project.id, serviceName } });
      if (reg) {
        reg.status = 'offline';
        await repo.save(reg);
      }
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/heartbeat', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();

    const regRepo = ds.getRepository(ServiceRegistration);
    
    // Lookup registration
    let registration = await regRepo.findOne({ where: { id: body.registrationId } });
    if (!registration) {
      // Lookup by project name fallback
      const project = await ds.getRepository(Project).findOne({ where: { name: body.projectId } });
      if (project) {
        registration = await regRepo.findOne({ where: { projectId: project.id } });
      }
    }

    if (registration) {
      registration.lastSeen = new Date();
      registration.status = 'online';
      await regRepo.save(registration);
    }

    if (body.dbHealth && registration) {
      const dbRepo = ds.getRepository(DbConnection);
      // dbHealth structure: { postgres: { activeCount: 2, idleCount: 8, status: 'connected' } }
      for (const [dbType, health] of Object.entries(body.dbHealth) as any) {
        let conn = await dbRepo.findOne({ where: { registrationId: registration.id, dbType: dbType as DbType } });
        if (!conn) {
          conn = dbRepo.create({
            registrationId: registration.id,
            projectId: registration.projectId,
            dbType: dbType as DbType,
            poolSize: 10,
            status: DbConnectionStatus.CONNECTED,
          });
        }
        conn.status = health.status === 'connected' ? DbConnectionStatus.CONNECTED : DbConnectionStatus.DISCONNECTED;
        conn.lastHeartbeat = new Date();
        conn.activeCount = health.activeCount ?? conn.activeCount;
        conn.idleCount = health.idleCount ?? conn.idleCount;
        await dbRepo.save(conn);
      }
    }

    await connectMongo();
    await MetricsRawModel.create({
      registrationId: registration?.id || null,
      projectId: registration?.projectId || body.projectId,
      environment: body.environment || registration?.environmentId || 'development',
      cpuPct: body.cpuPct || Math.random() * 20,
      memoryMb: body.memoryMb || 128 + Math.random() * 64,
      heapMb: body.heapMb || 80,
      uptimeS: body.uptimeS || 100,
      requestCount: body.requestCount || Math.floor(Math.random() * 10),
      avgResponseMs: body.avgResponseMs || 15,
      p95ResponseMs: body.p95ResponseMs || 40,
      errors4xx: body.errors4xx || 0,
      errors5xx: body.errors5xx || 0,
      dbHealth: body.dbHealth || {},
      timestamp: new Date(),
    });

    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

const handleSdkLogs = async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const logs: any[] = body.logs;

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: 'logs must be a non-empty array' });
    }

    await connectMongo();
    const ds = await getDb();
    
    // Resolve project IDs if SDK sent projectNames
    const projectRepo = ds.getRepository(Project);
    const resolvedLogs = [];

    for (const log of logs) {
      let resolvedProjectId = log.projectId;
      // If it looks like a projectName (non-uuid), resolve it
      if (log.projectId && !log.projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const project = await projectRepo.findOne({ where: { name: log.projectId } });
        if (project) resolvedProjectId = project.id;
      }

      resolvedLogs.push({
        projectId: resolvedProjectId,
        environment: log.environment || 'development',
        branch: log.branch || 'main',
        commitSha: log.commitSha || 'unknown',
        hostname: log.hostname || 'localhost',
        level: (log.level || 'INFO').toUpperCase(),
        message: log.message,
        fields: log.metadata || log.fields || {},
        timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
      });
    }

    await LogModel.insertMany(resolvedLogs);
    await forwardToLoki(resolvedLogs);

    // Track Errors
    const errorLogs = resolvedLogs.filter((log) => log.level === 'ERROR');
    for (const err of errorLogs) {
      const stackHash = err.fields?.stackHash || err.message;
      await ErrorDocModel.findOneAndUpdate(
        {
          projectId: err.projectId,
          errorType: err.fields?.errorType || 'UnknownError',
          stackHash,
        },
        {
          $set: {
            environment: err.environment,
            message: err.message,
            lastSeen: new Date(),
          },
          $inc: { occurrenceCount: 1 },
          $setOnInsert: { firstSeen: new Date() },
        },
        { upsert: true }
      );
    }

    return res.status(201).json({ received: logs.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
};

router.post('/sdk/logs', sdkTokenAuth, handleSdkLogs);
router.post('/logs/ingest', sdkTokenAuth, handleSdkLogs);

router.get('/sdk/config', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    let { projectId, environmentId } = req.query as Record<string, string>;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const ds = await getDb();
    
    // Resolve environment name to UUID if needed
    if (environmentId && !environmentId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      const envRepo = ds.getRepository(Environment);
      const env = await envRepo.findOne({ where: { name: environmentId as any, projectId } });
      if (env) environmentId = env.id;
    }
    // Resolve project ID by name if needed
    let resolvedProjectId = projectId;
    const project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (project) resolvedProjectId = project.id;

    const repo = ds.getRepository(ProjectConfig);
    const allConfigs = await repo.find({
      where: { projectId: resolvedProjectId },
    });

    const result: Record<string, string> = {};
    for (const cfg of allConfigs) {
      if (cfg.environmentId && environmentId && cfg.environmentId !== environmentId) continue;
      result[cfg.key] = cfg.isSecret ? '***' : cfg.value;
    }

    // Also include decrypted secrets from the new Secret entity
    const secretRepo = ds.getRepository(Secret);
    const allSecrets = await secretRepo.find({
      where: { projectId: resolvedProjectId, isActive: true },
    });
    const masterKey = process.env.SECRETS_ENCRYPTION_KEY;
    if (masterKey) {
      for (const s of allSecrets) {
        if (s.environmentId && environmentId && s.environmentId !== environmentId) continue;
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

router.get('/sdk/db-credentials', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { projectId, dbTypes } = req.query as Record<string, string>;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const ds = await getDb();
    
    // Resolve project ID by name if needed
    let resolvedProjectId = projectId;
    const project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (project) resolvedProjectId = project.id;

    // Fetch Infisical credentials dynamically if token exists, else return fallbacks
    const secrets = await fetchSecrets(resolvedProjectId, 'development');

    const result: Record<string, any> = {};
    const types = dbTypes ? dbTypes.split(',').map((t) => t.trim()) : ['postgres', 'mongo', 'redis'];

    if (types.includes('postgres')) {
      result.postgres = {
        host: secrets.POSTGRES_HOST || process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(secrets.POSTGRES_PORT || process.env.POSTGRES_PORT || '5432', 10),
        user: secrets.POSTGRES_USER || process.env.POSTGRES_USER || 'plat',
        password: secrets.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'plat',
        database: secrets.POSTGRES_DB || process.env.POSTGRES_DB || 'plat_platform',
        poolSize: 10,
      };
    }

    if (types.includes('mongo')) {
      result.mongo = {
        uri: secrets.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/plat_platform',
        poolSize: 5,
      };
    }

    if (types.includes('redis')) {
      result.redis = {
        host: secrets.REDIS_HOST || process.env.REDIS_HOST || 'localhost',
        port: parseInt(secrets.REDIS_PORT || process.env.REDIS_PORT || '6379', 10),
        password: secrets.REDIS_PASSWORD || process.env.REDIS_PASSWORD || '',
      };
    }

    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/api-metrics', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { metrics, projectId } = req.body;
    if (!Array.isArray(metrics) || metrics.length === 0) return res.json({ saved: 0 });
    await connectMongo();
    const docs = metrics.map((m: any) => ({
      projectId: projectId || m.projectId || 'unknown',
      route: m.route || '/',
      method: (m.method || 'GET').toUpperCase(),
      statusCode: m.statusCode || 200,
      durationMs: m.durationMs || 0,
      memoryDeltaBytes: m.memoryDeltaBytes || 0,
      sdkVersion: m.sdkVersion,
      environment: m.environment || 'production',
      timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
    }));
    await ApiMetricModel.insertMany(docs);
    return res.json({ saved: docs.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/sdk/api-metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environment, from, to } = req.query as Record<string, string>;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    await connectMongo();
    const dateFilter: any = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);
    const match: any = { projectId };
    if (environment) match.environment = environment;
    if (Object.keys(dateFilter).length) match.timestamp = dateFilter;

    const agg = await ApiMetricModel.aggregate([
      { $match: match },
      { $sort: { timestamp: -1 } },
      { $group: {
        _id: { route: '$route', method: '$method' },
        count: { $sum: 1 },
        avgDuration: { $avg: '$durationMs' },
        durations: { $push: '$durationMs' },
        errors4xx: { $sum: { $cond: [{ $and: [{ $gte: ['$statusCode', 400] }, { $lt: ['$statusCode', 500] }] }, 1, 0] } },
        errors5xx: { $sum: { $cond: [{ $gte: ['$statusCode', 500] }, 1, 0] } },
        lastSeen: { $max: '$timestamp' },
      }},
      { $addFields: {
        p50: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.50, { $size: '$durations' }] } }] },
        p95: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.95, { $size: '$durations' }] } }] },
        p99: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.99, { $size: '$durations' }] } }] },
      }},
      { $project: { durations: 0 } },
      { $sort: { count: -1 } },
    ]);

    return res.json({ metrics: agg });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/bug-report', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body.projectId || !body.description) return res.status(400).json({ error: 'projectId and description required' });
    await connectMongo();
    const report = await BugReportModel.create({
      projectId: body.projectId,
      environment: body.environment || 'unknown',
      description: body.description,
      category: body.category || 'Bug',
      consoleLogs: body.consoleLogs || [],
      networkTimeline: body.networkTimeline || [],
      screenshotBase64: body.screenshotBase64,
      browserInfo: body.browserInfo || {},
      appState: body.appState,
    });
    // If project has ClickUp linked — create task (non-blocking, best effort)
    (async () => {
      try {
        const ds = await getDb();
        const project = await ds.getRepository(Project).findOne({ where: { id: body.projectId } });
        if (project && project.clickupListId) {
          const taskTitle = `[BUG] ${body.category || 'Bug'}: ${body.description.substring(0, 80)}`;
          await postComment('auto', `Bug report created:\n\n${taskTitle}\n\nEnvironment: ${body.environment || 'unknown'}`);
        }
      } catch {}
    })();
    return res.status(201).json({ id: report._id, message: 'Bug report submitted' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
