import type { DataSource } from 'typeorm';
import { Environment } from '../entities/Environment';
import { Project } from '../entities/Project';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { loadKubeConfig } from './kube-config';
import { decryptValue } from './secrets-encryption';
import { observabilityInstalled } from './telemetry-config';
import { allowedBrowserOrigins, TELEMETRY_ORIGINS_CONFIG_KEY } from './telemetry-sdk-config';

/**
 * Browser CORS allow-list for the Faro receiver (#49).
 *
 * Alloy's `otelcol.receiver.faro` reads `cors.allowed_origins` from
 * /etc/telemetry-origins/origins.json, i.e. key `origins.json` of the ConfigMap
 * `monitoring/telemetry-origins` (created as `[]` by platformctl). The API owns
 * that key: it writes the union of every project's browser origins — the same
 * origins `buildTelemetryBlock` signs into browser ingest tokens (environment
 * hosts, project domain, TELEMETRY_ALLOWED_ORIGINS for any environment).
 *
 * The union only lets browsers *talk* to the collector. Per-project
 * authorisation stays with the ingest-auth check of the token's own origins.
 *
 * Origins are `scheme://host[:port]` (see normalizeOrigin) or
 * `scheme://*.domain`; the receiver (rs/cors via confighttp) accepts one `*`
 * wildcard per origin. A bare `*` is never written.
 *
 * Sync runs on the leader at startup and every 5 minutes, and on any replica
 * (debounced) when the variable changes. Writes happen only when the content
 * differs. Alloy polls the file every 10 s; kubelet refreshes ConfigMap
 * volumes within about a minute, so no restart is needed.
 */

export const ORIGINS_CONFIGMAP = 'telemetry-origins';
export const ORIGINS_KEY = 'origins.json';
export const ORIGINS_SYNC_JOB = 'telemetry-origins-sync';
/** Upper bounds that keep the ConfigMap (1 MiB limit) and the CORS matcher small. */
export const MAX_ORIGINS = 2000;
export const MAX_ORIGINS_BYTES = 128 * 1024;

export function originsNamespace(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.TELEMETRY_ORIGINS_NAMESPACE || 'monitoring').trim() || 'monitoring';
}

export interface OriginSource {
  envDomain?: string | null;
  projectDomain?: string | null;
  configured?: string | null;
}

/** Sorted, de-duplicated, size-bounded union of the origins of every source. */
export function unionOrigins(sources: OriginSource[], log: (m: string) => void = console.warn): string[] {
  const all = new Set<string>();
  for (const s of sources) for (const o of allowedBrowserOrigins(s)) all.add(o);
  const sorted = [...all].sort();
  const out: string[] = [];
  let bytes = 2; // []
  for (const o of sorted) {
    const size = JSON.stringify(o).length + 1;
    if (out.length >= MAX_ORIGINS || bytes + size > MAX_ORIGINS_BYTES) {
      log(`[telemetry-origins] ${sorted.length - out.length} origin(s) dropped: allow-list is capped at ${MAX_ORIGINS} entries / ${MAX_ORIGINS_BYTES} bytes`);
      break;
    }
    out.push(o);
    bytes += size;
  }
  return out;
}

export function renderOrigins(origins: string[]): string {
  return JSON.stringify(origins);
}

/** Read every project's browser-origin inputs from the database. */
export async function collectOriginSources(ds: DataSource, masterKey = process.env.SECRETS_ENCRYPTION_KEY || ''): Promise<OriginSource[]> {
  const sources: OriginSource[] = [];
  // Only live projects/environments: a soft-deleted project's browsers lose CORS too.
  const projects = await ds.getRepository(Project).find({ select: { id: true, domain: true, isActive: true, deletedAt: true } as any });
  const live = new Set<string>();
  for (const p of projects) {
    if (p.isActive === false || p.deletedAt) continue;
    live.add(p.id);
    if (p.domain) sources.push({ projectDomain: p.domain });
  }
  const envs = await ds.getRepository(Environment).find({ select: { id: true, projectId: true, domain: true, isActive: true } as any });
  for (const e of envs) if (e.domain && e.isActive !== false && live.has(e.projectId)) sources.push({ envDomain: e.domain });
  const configs = await ds.getRepository(ProjectConfig).find({ where: { key: TELEMETRY_ORIGINS_CONFIG_KEY } as any });
  for (const c of configs) if (!c.isSecret && c.value && c.projectId && live.has(c.projectId)) sources.push({ configured: c.value });
  if (masterKey) {
    const secrets = await ds.getRepository(Secret).find({ where: { key: TELEMETRY_ORIGINS_CONFIG_KEY, isActive: true } as any });
    for (const s of secrets) {
      if (!live.has(s.projectId)) continue;
      try {
        sources.push({ configured: decryptValue(s.encryptedValue, masterKey) });
      } catch {
        /* undecryptable value: ignore, the SDK config skips it too */
      }
    }
  }
  return sources;
}

/** The slice of the ConfigMap API the writer needs (tests inject a fake). */
export interface OriginsConfigMapApi {
  /** Current `origins.json`, '' when the key is absent, null when the ConfigMap does not exist. */
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

const notFound = (err: any) => Number(err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code) === 404;

export function kubeOriginsApi(namespace = originsNamespace()): OriginsConfigMapApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const k8s = require('@kubernetes/client-node');
  const core = loadKubeConfig(new k8s.KubeConfig()).makeApiClient(k8s.CoreV1Api);
  return {
    async read() {
      try {
        const cm: any = await core.readNamespacedConfigMap({ name: ORIGINS_CONFIGMAP, namespace });
        return String((cm?.body || cm)?.data?.[ORIGINS_KEY] ?? '');
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async write(content) {
      // Merge patch touches only our key and works whether or not `data` exists.
      // RBAC grants get/patch/update on this one ConfigMap (no create).
      await core.patchNamespacedConfigMap(
        { name: ORIGINS_CONFIGMAP, namespace, body: { data: { [ORIGINS_KEY]: content } } },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
      );
    },
  };
}

export type SyncResult = 'written' | 'unchanged' | 'missing' | 'disabled';

let missingLogged = false;

export async function syncTelemetryOrigins(deps: {
  ds?: DataSource;
  api?: OriginsConfigMapApi;
  enabled?: boolean;
  log?: (m: string) => void;
} = {}): Promise<SyncResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  if (!(deps.enabled ?? observabilityInstalled())) return 'disabled';
  const ds = deps.ds ?? (await (await import('../config/database')).getDb());
  const api = deps.api ?? kubeOriginsApi();
  const content = renderOrigins(unionOrigins(await collectOriginSources(ds), log));
  const current = await api.read();
  if (current === null) {
    if (!missingLogged) log(`[telemetry-origins] ConfigMap ${originsNamespace()}/${ORIGINS_CONFIGMAP} not found; browser CORS stays closed`);
    missingLogged = true;
    return 'missing';
  }
  missingLogged = false;
  if (current === content) return 'unchanged';
  await api.write(content);
  log(`[telemetry-origins] browser CORS allow-list updated (${(JSON.parse(content) as string[]).length} origin(s))`);
  return 'written';
}

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced sync after a project changes TELEMETRY_ALLOWED_ORIGINS (or a domain).
 * Runs on the replica that served the request; the write is idempotent, so a
 * concurrent leader run is harmless. Failures are retried by the periodic job.
 */
export function requestTelemetryOriginsSync(delayMs = 1000): void {
  if (!observabilityInstalled()) return;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    syncTelemetryOrigins().catch((err) => console.warn(`[telemetry-origins] sync failed: ${err?.message || err}`));
  }, delayMs);
  pending.unref?.();
}

/** True when a config/secret write touches the browser-origin allow-list. */
export function affectsTelemetryOrigins(key: unknown): boolean {
  return String(key || '').trim() === TELEMETRY_ORIGINS_CONFIG_KEY;
}
