import { ensureProjectNamespace } from '../lib/namespace-baseline';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { Project, StackType } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { ServiceRegistration } from '../entities/ServiceRegistration';
import { DbConnection, DbConnectionStatus, DbType } from '../entities/DbConnection';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { sdkTokenAuth, expressAuthenticate, sdkProjectMatches, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { decryptValue } from '../lib/secrets-encryption';
import { ingestTelemetry, TelemetryBackpressureError, TelemetryPayloadTooLargeError } from '../lib/telemetry-queue';
import type { ApiMetricDoc, HeartbeatEvent, LogDoc, TelemetryKind } from '../lib/telemetry-processors';
import { buildTelemetryBlock } from '../lib/telemetry-sdk-config';
import { SdkEventModel } from '../schemas/SdkEvent';
import { BugReportModel } from '../schemas/BugReport';
import * as k8s from '@kubernetes/client-node';
import { ApiMetricModel } from '../schemas/ApiMetric';
import { postComment } from '../lib/clickup';
import { resolveProjectRef } from '../lib/project-resolve';
import { ensureProjectIngress } from '../lib/k8s';
import { gitUrlsMatch, normalizeGitUrl } from '../lib/git-url';
import { assignedNamespace, assignedEnvHost, projectSlug as makeProjectSlug } from '../lib/project-namespace';
import { loadKubeConfig } from '../lib/kube-config';

const router = Router();

/**
 * SDK credentials are bound to exactly one project. Any project reference the client
 * sends (UUID or name) must be that project; otherwise respond 403 and return true.
 */
function rejectForeignProject(req: Request, res: Response, ...refs: unknown[]): boolean {
  const authReq = req as AuthenticatedRequest;
  for (const ref of refs) {
    if (!sdkProjectMatches(authReq, ref)) {
      res.status(403).json({ error: 'Forbidden: SDK token is not valid for this project' });
      return true;
    }
  }
  return false;
}

/**
 * True when a value is one of the platform's own secrets. project-db-ensure copies e.g. the
 * shared REDIS_PASSWORD into project secrets, so /sdk/config must filter by value, not key.
 */
function isPlatformSecretValue(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 4) return false;
  const platformValues = [
    process.env.POSTGRES_PASSWORD,
    process.env.REDIS_PASSWORD,
    process.env.MONGODB_URI,
    process.env.MONGO_URI,
    process.env.JWT_SECRET,
    process.env.SECRETS_ENCRYPTION_KEY,
  ].filter((v): v is string => !!v && v.length >= 4);
  return platformValues.includes(value);
}

/**
 * Defence in depth: never hand the platform's own database credentials to an SDK client.
 * project-db-ensure returns per-project credentials (Postgres role, MongoDB user, Redis ACL
 * user) or { status: 'error' }; anything that looks platform-owned is replaced by an error.
 */
function withoutPlatformCredentials(result: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...result };
  const refused = (db: string) => ({
    status: 'error',
    error: `${db} credentials for this project are not available (provisioning incomplete). Platform credentials are never returned.`,
  });

  const pg = out.postgres;
  if (pg && pg.status !== 'error') {
    const platUser = process.env.POSTGRES_USER || 'plat';
    const platPass = process.env.POSTGRES_PASSWORD || 'plat';
    const platDb = process.env.POSTGRES_DB || 'plat_platform';
    if (!pg.user || !pg.password || pg.user === platUser || pg.user === 'postgres' || pg.password === platPass || pg.database === platDb) {
      out.postgres = refused('postgres');
    }
  }

  const mongo = out.mongo;
  if (mongo) {
    const platUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/plat_platform';
    const dbPath = (uri: string) => {
      try { return new URL(uri).pathname.replace(/^\/+/, ''); } catch { return uri.split('?')[0].split('/').slice(3).join('/'); }
    };
    const uriUser = (uri: string) => {
      const m = /^mongodb(?:\+srv)?:\/\/([^@/]*)@/.exec(uri);
      return m ? decodeURIComponent(m[1].split(':')[0]) : '';
    };
    if (mongo.status !== 'error' && (!mongo.uri || mongo.uri === platUri || dbPath(mongo.uri) === dbPath(platUri) || dbPath(mongo.uri) === ''
      || !uriUser(mongo.uri) || uriUser(mongo.uri) === uriUser(platUri))) {
      // Only a per-project MongoDB user (readWrite on its own database) may be handed out.
      out.mongo = refused('mongo');
    }
  }

  const redis = out.redis;
  const platRedisPass = process.env.REDIS_PASSWORD || '';
  if (redis && redis.status !== 'error' && (!redis.keyPrefix || !redis.username || redis.username === 'default'
    || !redis.password || (platRedisPass && redis.password === platRedisPass))) {
    // Only a per-project ACL user confined to its key prefix is isolation; the default user or
    // the platform's own Redis password would share the whole keyspace.
    out.redis = refused('redis');
  }
  return out;
}

router.post('/sdk/register', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body?.projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    if (!body?.environmentName) {
      return res.status(400).json({ error: 'environmentName is required' });
    }
    if (rejectForeignProject(req, res, body.projectName, body.projectId)) return;
    const ds = await getDb();

    // The project is always the one the SDK token was issued for — never created or
    // selected from the request body.
    const projectRepo = ds.getRepository(Project);
    let project = await projectRepo.findOne({ where: { id: (req as AuthenticatedRequest).projectId } });
    if (!project) {
      return res.status(404).json({ error: 'Project for this SDK token not found' });
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
        await ensureProjectNamespace(project.id, env);
        const customApi = new k8s.KubeConfig();
        loadKubeConfig(customApi);
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
              syncOptions: [],
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
            projectId: project.id, environmentName: String(env.name),
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
      loadKubeConfig(kc);
      const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
      const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
      const networkV1 = kc.makeApiClient(k8s.NetworkingV1Api);
      // Project namespace only — never the platform's own namespace (SDK tokens are project-scoped).
      const ns = destNamespace;
      const deployName = `${project.name}-${body.serviceName || 'app'}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      // Client-supplied images are not accepted: an SDK token must not choose what runs in the cluster.
      const image = `${project.name}:latest`;
      await ensureProjectNamespace(project.id, env);

      // Deployment
      const deployment = {
        metadata: { name: deployName, namespace: ns, labels: { app: deployName, project: project.name } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: deployName } },
          template: {
            metadata: { labels: { app: deployName, project: project.name } },
            spec: {
              automountServiceAccountToken: false,
              securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [{
                name: 'app',
                image,
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
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
    if (rejectForeignProject(req, res, projectId)) return;
    if (!serviceName || typeof serviceName !== 'string') {
      return res.status(400).json({ error: 'serviceName is required' });
    }
    const ds = await getDb();

    const repo = ds.getRepository(ServiceRegistration);
    const reg = await repo.findOne({ where: { projectId: (req as AuthenticatedRequest).projectId, serviceName } });
    if (reg) {
      reg.status = 'offline';
      await repo.save(reg);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Telemetry ingest (issue #49): validate and authorize synchronously, then hand the
 * project-bound payload to the queue (lib/telemetry-queue). 202 when queued; when the
 * queue is not in use (memory state mode, TELEMETRY_QUEUE=off, Redis outage) the payload
 * is processed inline and the historical status is returned. 429 + Retry-After above the
 * backlog threshold.
 */
async function acceptTelemetry(
  res: Response,
  kind: TelemetryKind,
  projectId: string,
  payload: unknown,
  count: number,
  inline: { status: number; body: Record<string, unknown> },
  queuedBody: Record<string, unknown>,
) {
  try {
    const outcome = await ingestTelemetry(kind, projectId, payload, count);
    if (outcome === 'queued') return res.status(202).json({ ...queuedBody, queued: true });
    return res.status(inline.status).json(inline.body);
  } catch (err: any) {
    if (err instanceof TelemetryBackpressureError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds });
    }
    if (err instanceof TelemetryPayloadTooLargeError) {
      return res.status(413).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message });
  }
}

const HEARTBEAT_FIELDS = [
  'registrationId', 'environment', 'cpuPct', 'memoryMb', 'heapMb', 'uptimeS', 'requestCount',
  'avgResponseMs', 'p95ResponseMs', 'errors4xx', 'errors5xx', 'dbHealth',
] as const;

router.post('/sdk/heartbeat', sdkTokenAuth, async (req: Request, res: Response) => {
  const body = req.body || {};
  if (rejectForeignProject(req, res, body.projectId)) return;
  const tokenProjectId = (req as AuthenticatedRequest).projectId!;
  const picked: Record<string, unknown> = {};
  for (const k of HEARTBEAT_FIELDS) if (body[k] !== undefined) picked[k] = body[k];
  const event: HeartbeatEvent = { projectId: tokenProjectId, body: picked, receivedAt: new Date().toISOString() };
  return acceptTelemetry(res, 'heartbeat', tokenProjectId, event, 1, { status: 200, body: { ok: true } }, { ok: true });
});

const handleSdkLogs = async (req: Request, res: Response) => {
  const body = req.body || {};
  const logs: any[] = body.logs;

  if (!Array.isArray(logs)) {
    return res.status(400).json({ error: 'logs must be an array' });
  }
  if (logs.length === 0) {
    return res.status(201).json({ received: 0 });
  }

  // Every entry must belong to the token's project (UUID or name, or omitted).
  if (rejectForeignProject(req, res, body.projectId, ...logs.map((l) => l?.projectId))) return;
  // Validated here (not only by the Log schema) so a queued batch cannot fail later.
  if (logs.some((l) => !l || typeof l !== 'object' || l.message === undefined || l.message === null || l.message === '')) {
    return res.status(400).json({ error: 'every log entry needs a message' });
  }
  const tokenProjectId = (req as AuthenticatedRequest).projectId!;

  const resolvedLogs: LogDoc[] = logs.map((log) => ({
    projectId: tokenProjectId,
    environment: log.environment || 'development',
    branch: log.branch || 'main',
    commitSha: log.commitSha || 'unknown',
    hostname: log.hostname || 'localhost',
    level: String(log.level || 'INFO').toUpperCase(),
    message: log.message,
    fields: log.metadata || log.fields || {},
    timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
  }));

  return acceptTelemetry(res, 'logs', tokenProjectId, resolvedLogs, logs.length,
    { status: 201, body: { received: logs.length } }, { received: logs.length });
};

router.post('/sdk/logs', sdkTokenAuth, handleSdkLogs);
router.post('/logs/ingest', sdkTokenAuth, handleSdkLogs);

router.get('/sdk/config', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    let { projectId, environmentId } = req.query as Record<string, string>;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (rejectForeignProject(req, res, projectId)) return;
    if (environmentId !== undefined && typeof environmentId !== 'string') {
      return res.status(400).json({ error: 'environmentId must be a string' });
    }
    // Always the token's project — never resolved from the query.
    const resolvedProjectId = (req as AuthenticatedRequest).projectId!;

    const ds = await getDb();
    const environmentRef = environmentId;

    // Resolve environment name to UUID if needed
    if (environmentId && !environmentId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      const envRepo = ds.getRepository(Environment);
      const env = await envRepo.findOne({ where: { name: environmentId as any, projectId: resolvedProjectId } });
      if (env) environmentId = env.id;
    }

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
          const value = decryptValue(s.encryptedValue, masterKey);
          // Platform-owned credentials copied into project secrets are never served to SDKs.
          if (isPlatformSecretValue(value)) continue;
          result[s.key] = value;
        } catch {}
      }
    }

    // Collector endpoints + short-lived ingest tokens (issue #49). Object-valued key; config
    // values are strings, so SDKs can tell it apart from a user key of the same name.
    const telemetry = await buildTelemetryBlock({ ds, projectId: resolvedProjectId, environmentRef, configValues: result });
    return res.json({ ...result, telemetry });
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

    if (rejectForeignProject(req, res, projectId)) return;
    if ((dbTypes !== undefined && typeof dbTypes !== 'string') || (environment !== undefined && typeof environment !== 'string')) {
      return res.status(400).json({ error: 'dbTypes and environment must be strings' });
    }

    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: (req as AuthenticatedRequest).projectId } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const envName = environment || 'development';
    const types = dbTypes ? dbTypes.split(',').map((t) => t.trim()).filter(Boolean) : ['postgres', 'mongo', 'redis'];
    const { resolveProjectDbCredentials } = await import('../lib/project-db-ensure');
    const result = await resolveProjectDbCredentials(project.id, project.name, envName, types);
    return res.json(withoutPlatformCredentials(result));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/api-metrics', sdkTokenAuth, async (req: Request, res: Response) => {
  const { metrics, projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  if (rejectForeignProject(req, res, projectId)) return;
  if (metrics === undefined || metrics === null) return res.status(400).json({ error: 'metrics array is required' });
  if (!Array.isArray(metrics)) return res.status(400).json({ error: 'metrics must be an array' });
  if (rejectForeignProject(req, res, ...metrics.map((m: any) => m?.projectId))) return;
  if (metrics.length === 0) return res.status(201).json({ saved: 0 });
  const resolvedId = (req as AuthenticatedRequest).projectId!;
  const docs: ApiMetricDoc[] = metrics.map((m: any) => ({
    projectId: resolvedId,
    route: m?.route || '/',
    method: String(m?.method || 'GET').toUpperCase(),
    statusCode: m?.statusCode || 200,
    durationMs: m?.durationMs || 0,
    memoryDeltaBytes: m?.memoryDeltaBytes || 0,
    sdkVersion: m?.sdkVersion,
    environment: m?.environment || 'production',
    timestamp: m?.timestamp ? new Date(m.timestamp) : new Date(),
  }));
  return acceptTelemetry(res, 'api-metrics', resolvedId, docs, docs.length,
    { status: 201, body: { saved: docs.length } }, { accepted: docs.length });
});

router.get('/sdk/api-metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environment, from, to } = req.query as Record<string, string>;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (typeof projectId !== 'string') return res.status(400).json({ error: 'projectId must be a string' });
    const ds = await getDb();
    const ref = await resolveProjectRef(ds, projectId);
    if (!ref) return res.status(404).json({ error: 'Project not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, ref.id);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    await connectMongo();
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
    if (rejectForeignProject(req, res, body.projectId)) return;
    const tokenProjectId = (req as AuthenticatedRequest).projectId!;
    await connectMongo();
    const report = await BugReportModel.create({
      projectId: tokenProjectId,
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
        const project = await ds.getRepository(Project).findOne({ where: { id: tokenProjectId } });
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
