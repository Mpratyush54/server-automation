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
import { resolveProjectRef } from '../lib/project-resolve';
import { ensureProjectIngress } from '../lib/k8s';
import { gitUrlsMatch, normalizeGitUrl } from '../lib/git-url';
import { assignedNamespace, assignedEnvHost, projectSlug as makeProjectSlug } from '../lib/project-namespace';

const router = Router();

router.post('/sdk/register', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body?.projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    if (!body?.environmentName) {
      return res.status(400).json({ error: 'environmentName is required' });
    }
    const ds = await getDb();
    
    // Resolve project ID by name if needed
    const projectRepo = ds.getRepository(Project);
    let project = await projectRepo.findOne({ where: { name: body.projectName } });
    if (!project) {
      // Create project on-the-fly to facilitate local testing
      project = projectRepo.create({
        name: body.projectName,
        stack: StackType.NODEJS,
        domain: body.domain || process.env.DOMAIN || null,
        repositoryUrl: body.repositoryUrl || null,
      });
      project = await projectRepo.save(project);
    } else {
      let dirty = false;
      if (body.domain && body.domain !== project.domain) {
        project.domain = body.domain;
        dirty = true;
      }
      // Git origin: SDK must match the project repo on the server (cannot silently overwrite)
      if (body.repositoryUrl) {
        if (project.repositoryUrl && !gitUrlsMatch(body.repositoryUrl, project.repositoryUrl)) {
          return res.status(409).json({
            error: 'SDK repositoryUrl does not match project repository on the server',
            serverRepositoryUrl: project.repositoryUrl,
            sdkRepositoryUrl: body.repositoryUrl,
            hint: 'Update the project Git URL in the portal, or point the SDK at the same origin',
          });
        }
        if (!project.repositoryUrl) {
          project.repositoryUrl = body.repositoryUrl;
          dirty = true;
        }
      }
      if (dirty) project = await projectRepo.save(project);
    }

    // Resolve environment — namespace is ALWAYS server-assigned
    const envRepo = ds.getRepository(Environment);
    const envName = body.environmentName || 'development';
    const baseDomain = project.domain || body.domain || process.env.DOMAIN || 'sslip.io';
    const ns = assignedNamespace(project.name, envName);
    const host = assignedEnvHost(project.name, envName, baseDomain);

    let env = await envRepo.findOne({ where: { projectId: project.id, name: envName as any } });
    if (!env) {
      env = envRepo.create({
        name: envName as any,
        namespace: ns,
        domain: host,
        projectId: project.id,
      });
      env = await envRepo.save(env);
    } else {
      // Force server-owned namespace/domain (ignore any client override)
      let envDirty = false;
      if (env.namespace !== ns) {
        env.namespace = ns;
        envDirty = true;
      }
      if (!env.domain || env.domain.includes('example.com') || env.domain !== host) {
        env.domain = host;
        envDirty = true;
      }
      if (envDirty) env = await envRepo.save(env);
    }

    if (body.namespace && body.namespace !== env.namespace) {
      console.warn(
        `[sdk/register] Ignoring client namespace "${body.namespace}" — server assigned "${env.namespace}"`,
      );
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

    // Ensure/init project databases and persist credentials for getDbCredentials
    let databasesStatus: Record<string, { status: string; error?: string }> = {};
    if (body.dbTypes && Array.isArray(body.dbTypes) && body.dbTypes.length) {
      try {
        const { ensureProjectDatabases } = await import('../lib/project-db-ensure');
        // Provision for the active env first, then mirror to other envs for convenience
        const envs = Array.from(new Set([body.environmentName, 'development', 'staging', 'production'].filter(Boolean)));
        for (const envName of envs) {
          const status = await ensureProjectDatabases(project.id, project.name, envName, body.dbTypes);
          if (envName === body.environmentName) databasesStatus = status;
        }
      } catch (e) {
        console.warn('[sdk/register] Failed to ensure databases:', (e as Error).message);
        databasesStatus = { _error: { status: 'error', error: (e as Error).message } };
      }
    }

    // Domain may still be set once from SDK if project has none
    if (body.domain && !project.domain) {
      project.domain = body.domain;
      project = await projectRepo.save(project);
    }

    // Always use server project repo (already validated against SDK origin if provided)
    const repoUrl = project.repositoryUrl || '';
    const gitPath =
      body.gitPath ||
      body.k8sPath ||
      (repoUrl.toLowerCase().includes('server-automation')
        ? 'examples/sdk-apps/k8s'
        : 'k8s');
    const gitRevision = body.gitRevision || body.branch || 'main';
    const useGitops = body.gitops !== false && !!repoUrl;
    const slug = makeProjectSlug(project.name);
    const destNamespace = env.namespace; // server-owned only — never body.namespace
    let gitopsInfo: Record<string, any> | null = null;

    // Auto-create / refresh ArgoCD Application from SDK register (GitHub → ArgoCD)
    if (useGitops) {
      try {
        const customApi = new k8s.KubeConfig();
        try { customApi.loadFromCluster(); } catch { try { customApi.loadFromDefault(); } catch {} }
        const apiClient = customApi.makeApiClient(k8s.CustomObjectsApi);
        const appName = destNamespace.slice(0, 63);
        const application = {
          apiVersion: 'argoproj.io/v1alpha1',
          kind: 'Application',
          metadata: {
            name: appName,
            namespace: 'argocd',
            labels: {
              'app.kubernetes.io/managed-by': 'platform-sdk',
              'platform.project': slug,
            },
          },
          spec: {
            project: 'default',
            source: {
              repoURL: repoUrl,
              targetRevision: gitRevision,
              path: gitPath,
            },
            destination: {
              server: 'https://kubernetes.default.svc',
              namespace: destNamespace,
            },
            syncPolicy: {
              automated: { prune: true, selfHeal: true },
              syncOptions: ['CreateNamespace=true'],
            },
          },
        };

        try {
          const existing: any = await apiClient.getNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
            plural: 'applications', name: appName,
          });
          (application.metadata as any).resourceVersion = existing?.metadata?.resourceVersion;
          await apiClient.replaceNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
            plural: 'applications', name: appName, body: application as any,
          });
        } catch {
          await apiClient.createNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
            plural: 'applications',
            body: application as any,
          });
        }

        gitopsInfo = {
          argoApplication: appName,
          repositoryUrl: repoUrl,
          gitPath,
          gitRevision,
          namespace: destNamespace,
        };

        // Wire HTTPS Ingress for the environment host (Let's Encrypt, incl. sslip.io)
        try {
          const { ensureProjectIngress } = await import('../lib/k8s');
          const host = env.domain || assignedEnvHost(project.name, env.name, project.domain || process.env.DOMAIN || 'sslip.io');
          const serviceName = body.serviceName || body.ingressServiceName || 'sdk-node-api';
          const servicePort = Number(body.servicePort || body.ingressServicePort || 80);
          const ingress = await ensureProjectIngress({
            name: appName,
            namespace: destNamespace,
            host,
            serviceName,
            servicePort,
          });
          gitopsInfo.ingressHost = ingress.host;
          gitopsInfo.tls = ingress.ok;
          gitopsInfo.serviceName = serviceName;
          gitopsInfo.namespace = destNamespace;
          gitopsInfo.repositoryUrlNormalized = normalizeGitUrl(repoUrl);
          if (ingress.ok && (!env.domain || env.domain.includes('example.com'))) {
            env.domain = host;
            await envRepo.save(env);
          }
        } catch (ingErr: any) {
          console.warn('[sdk/register] ingress TLS setup:', ingErr.message);
        }
      } catch (e) {
        console.warn('[sdk/register] Failed to create ArgoCD Application:', (e as Error).message);
        gitopsInfo = { error: (e as Error).message, repositoryUrl: repoUrl, gitPath, gitRevision };
      }
    }

    // Legacy fallback: direct Deployment only when NOT using GitOps from GitHub.
    // (Avoids ImagePullBackOff on "{project}:latest" while Argo owns the real deploy.)
    if (!useGitops) {
    const serviceName = body.serviceName || project.name;
    try {
      const kc = new k8s.KubeConfig();
      try { kc.loadFromCluster(); } catch { try { kc.loadFromDefault(); } catch {} }
      const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
      const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
      const networkV1 = kc.makeApiClient(k8s.NetworkingV1Api);
      const ns = 'platform';
      const deployName = `${project.name}-${body.serviceName || 'app'}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const image = body.image || `${project.name}:latest`;

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
                image,
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

      // Ingress with Let's Encrypt TLS (sslip.io included — HTTP-01 works per-host)
      const domain = project.domain || process.env.DOMAIN || 'sslip.io';
      const host = `${deployName}.${domain}`;
      const ingress: any = {
        metadata: {
          name: deployName,
          namespace: ns,
          annotations: {
            'kubernetes.io/ingress.class': 'nginx',
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
            'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
          },
        },
        spec: {
          ingressClassName: 'nginx',
          tls: [{ hosts: [host], secretName: `${deployName}-tls` }],
          rules: [{
            host,
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
      try { await networkV1.createNamespacedIngress({ namespace: ns, body: ingress as any }); }
      catch { try { await networkV1.replaceNamespacedIngress({ name: deployName, namespace: ns, body: ingress as any }); } catch {} }
    } catch (e) {
      console.warn('[sdk/register] Failed to create K8s resources:', (e as Error).message);
    }
    }

    return res.status(201).json({
      ...saved,
      registrationId: saved.id,
      projectId: project.id,
      projectName: project.name,
      namespace: destNamespace,
      repositoryUrl: repoUrl || null,
      databases: databasesStatus,
      gitops: gitopsInfo,
      warnings: body.namespace && body.namespace !== destNamespace
        ? [`Client namespace ignored; server assigned ${destNamespace}`]
        : [],
    });
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
    const projectRef = registration
      ? { id: registration.projectId, name: body.projectId }
      : await resolveProjectRef(ds, body.projectId);
    await MetricsRawModel.create({
      registrationId: registration?.id || null,
      projectId: projectRef?.id || registration?.projectId || body.projectId,
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

    if (!Array.isArray(logs)) {
      return res.status(400).json({ error: 'logs must be an array' });
    }
    if (logs.length === 0) {
      return res.status(201).json({ received: 0 });
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
    const { projectId, dbTypes, environment } = req.query as Record<string, string>;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const ds = await getDb();
    let project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (!project) {
      project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
    }
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const envName = environment || 'development';
    const types = dbTypes ? dbTypes.split(',').map((t) => t.trim()).filter(Boolean) : ['postgres', 'mongo', 'redis'];
    const { resolveProjectDbCredentials } = await import('../lib/project-db-ensure');
    const result = await resolveProjectDbCredentials(project.id, project.name, envName, types);
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/api-metrics', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { metrics, projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (metrics === undefined || metrics === null) return res.status(400).json({ error: 'metrics array is required' });
    if (!Array.isArray(metrics)) return res.status(400).json({ error: 'metrics must be an array' });
    if (metrics.length === 0) return res.status(201).json({ saved: 0 });
    await connectMongo();
    const ds = await getDb();
    const projectRef = await resolveProjectRef(ds, projectId || metrics[0]?.projectId);
    const resolvedId = projectRef?.id || projectId || metrics[0]?.projectId || 'unknown';
    const docs = metrics.map((m: any) => ({
      projectId: resolvedId,
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
    return res.status(201).json({ saved: docs.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/sdk/api-metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environment, from, to } = req.query as Record<string, string>;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    await connectMongo();
    const ds = await getDb();
    const { projectIdMongoFilter } = await import('../lib/project-resolve');
    const idFilter = await projectIdMongoFilter(ds, projectId);
    const dateFilter: any = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);
    const match: any = { ...idFilter };
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
