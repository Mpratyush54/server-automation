import type { DataSource } from 'typeorm';
import { Environment } from '../entities/Environment';
import { Project } from '../entities/Project';
import { samplingRatio, telemetryEndpoints } from './telemetry-config';
import { issueIngestToken, normalizeOrigin } from './telemetry-tokens';

/**
 * The `telemetry` block of GET /api/sdk/config (shared Wave A telemetry contract, #49).
 * SDKs send OTLP / Faro / profiles straight to the collector with these short-lived ingest
 * tokens; they refresh the config before `ingestTokenExpiresAt`. When the observability
 * backend is not installed (PLATFORM_OBSERVABILITY unset) `enabled` is false and every
 * endpoint/token is null, so SDKs do nothing.
 */
export interface TelemetryBlock {
  enabled: boolean;
  errorsEndpoint?: string | null;
  /** Browser heatmap ingest (`POST /api/sdk/heatmap/events`); accepts browserToken. */
  heatmapsEndpoint?: string | null;
  otlpEndpoint: string | null;
  faroEndpoint: string | null;
  profilesEndpoint: string | null;
  ingestToken: string | null;
  ingestTokenExpiresAt: string | null;
  browserToken: string | null;
  samplingRatio: number;
  resource: { 'platform.project_id': string; 'deployment.environment': string };
}

/** Explicit public API origin is required when DOMAIN is absent (custom collector setups). */
function errorIngestEndpoint(): string | null {
  const base = process.env.API_PUBLIC_URL || process.env.API_URL || (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : '');
  return base ? base.replace(/\/+$/, '') + '/api/errors/rum' : null;
}

/** Project config key listing extra browser origins for the Faro token (comma/space separated). */
export const TELEMETRY_ORIGINS_CONFIG_KEY = 'TELEMETRY_ALLOWED_ORIGINS';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const DEFAULT_ENV = 'development';

function hostOrigin(host: string | null | undefined): string | null {
  if (!host || /example\.com$/i.test(host)) return null;
  return normalizeOrigin(host);
}

/** Browser origins a project's Faro token is accepted from. */
export function allowedBrowserOrigins(opts: {
  envDomain?: string | null;
  projectDomain?: string | null;
  configured?: string | null;
}): string[] {
  const out = new Set<string>();
  for (const h of [opts.envDomain, opts.projectDomain]) {
    const o = hostOrigin(h);
    if (o) out.add(o);
  }
  for (const raw of String(opts.configured || '').split(/[\s,]+/)) {
    const o = raw ? normalizeOrigin(raw) : null;
    if (o) out.add(o);
  }
  return [...out].sort();
}

function disabledBlock(projectId: string, environment: string): TelemetryBlock {
  return {
    enabled: false,
    otlpEndpoint: null,
    faroEndpoint: null,
    profilesEndpoint: null,
    ingestToken: null,
    ingestTokenExpiresAt: null,
    browserToken: null,
    samplingRatio: samplingRatio(),
    resource: { 'platform.project_id': projectId, 'deployment.environment': environment },
  };
}

export async function buildTelemetryBlock(opts: {
  ds: DataSource;
  projectId: string;
  /** environmentId query value: an Environment UUID or name (optional). */
  environmentRef?: string;
  /** Project config values visible to this SDK call (for TELEMETRY_ALLOWED_ORIGINS). */
  configValues?: Record<string, string>;
}): Promise<TelemetryBlock> {
  const ref = typeof opts.environmentRef === 'string' ? opts.environmentRef.trim() : '';
  const guessedEnv = ref && !UUID_RE.test(ref) && ENV_NAME_RE.test(ref) ? ref : DEFAULT_ENV;
  const endpoints = telemetryEndpoints();
  if (!endpoints) return disabledBlock(opts.projectId, guessedEnv);

  let environment = guessedEnv;
  let envDomain: string | null = null;
  let projectDomain: string | null = null;
  try {
    let env: Environment | null = null;
    if (ref) {
      env = await opts.ds.getRepository(Environment).findOne({
        where: UUID_RE.test(ref) ? { id: ref, projectId: opts.projectId } : { name: ref as any, projectId: opts.projectId },
      });
    }
    if (env && env.projectId === opts.projectId && ENV_NAME_RE.test(String(env.name))) {
      environment = String(env.name);
      envDomain = env.domain || null;
    }
    const project = await opts.ds.getRepository(Project).findOne({ where: { id: opts.projectId } });
    projectDomain = project?.domain || null;
  } catch (err: any) {
    console.warn(`[telemetry] sdk/config environment lookup failed: ${err?.message || err}`);
  }

  try {
    const server = await issueIngestToken({ projectId: opts.projectId, environment, type: 'server' });
    const origins = allowedBrowserOrigins({
      envDomain,
      projectDomain,
      configured: opts.configValues?.[TELEMETRY_ORIGINS_CONFIG_KEY],
    });
    const browser = origins.length
      ? await issueIngestToken({ projectId: opts.projectId, environment, type: 'web', origins })
      : null;
    return {
      enabled: true,
      errorsEndpoint: errorIngestEndpoint(),
      heatmapsEndpoint: errorIngestEndpoint()?.replace(/\/errors\/rum$/,'/sdk/heatmap/events') ?? null,
      ...endpoints,
      ingestToken: server.token,
      ingestTokenExpiresAt: server.expiresAt.toISOString(),
      browserToken: browser?.token ?? null,
      samplingRatio: samplingRatio(),
      resource: { 'platform.project_id': opts.projectId, 'deployment.environment': environment },
    };
  } catch (err: any) {
    // Signing key unavailable: SDKs stay off until the next config refresh.
    console.warn(`[telemetry] ingest token not issued: ${err?.message || err}`);
    return disabledBlock(opts.projectId, environment);
  }
}
