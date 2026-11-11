import type { DataSource } from 'typeorm';
import {
  DEFAULT_CONSENT,
  DEFAULT_RETENTION_DAYS,
  PrivacyConsentDefaults,
  TelemetryPrivacySettings,
  TelemetryRetentionDays,
} from '../entities/TelemetryPrivacySettings';
import { ScrubOptions, ScrubRule, validateScrubRule } from './pii-scrub';

const DAY_MIN = 1;
const DAY_MAX = 365;

export function clampRetentionDays(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(DAY_MAX, Math.max(DAY_MIN, Math.floor(n)));
}

/**
 * Retention that actually applies per data type:
 *  - errors   per project (error-retention leader job, Postgres error_events)
 *  - logs     per project (Loki runtime overrides, lib/loki-retention); default = cluster
 *  - replays  per project (replay-retention leader job: replay_sessions rows + MinIO objects)
 *  - heatmaps per project (heatmaps-retention leader job, Postgres heatmap aggregates)
 *  - traces / profiles: cluster-wide only (TELEMETRY_RETENTION_DAYS on Tempo / Pyroscope).
 *    Both run single-tenant, so there is no per-project retention to apply.
 */
export const PROJECT_RETENTION_KEYS = ['logs', 'replays', 'errors', 'heatmaps'] as const;
export const CLUSTER_RETENTION_KEYS = ['traces', 'profiles'] as const;
export type ProjectRetentionKey = typeof PROJECT_RETENTION_KEYS[number];

/** Cluster telemetry retention (Loki/Tempo/Pyroscope), set by platformctl. */
export function clusterRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return clampRetentionDays(env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS.logs);
}

export function defaultRetentionDays(env: NodeJS.ProcessEnv = process.env): Required<TelemetryRetentionDays> {
  const cluster = clusterRetentionDays(env);
  return { logs: cluster, traces: cluster, profiles: cluster, replays: DEFAULT_RETENTION_DAYS.replays, errors: DEFAULT_RETENTION_DAYS.errors, heatmaps: DEFAULT_RETENTION_DAYS.heatmaps };
}

/** Effective retention: project overrides where supported, defaults elsewhere. */
export function mergeRetention(partial?: TelemetryRetentionDays | null, env: NodeJS.ProcessEnv = process.env): Required<TelemetryRetentionDays> {
  const d = defaultRetentionDays(env);
  return {
    logs: clampRetentionDays(partial?.logs, d.logs),
    traces: d.traces,
    profiles: d.profiles,
    replays: clampRetentionDays(partial?.replays, d.replays),
    errors: clampRetentionDays(partial?.errors, d.errors),
    heatmaps: clampRetentionDays(partial?.heatmaps, d.heatmaps),
  };
}

/** Stored overrides that are applied (legacy traces/profiles values are ignored). */
export function retentionOverrides(stored?: TelemetryRetentionDays | null): TelemetryRetentionDays {
  const out: TelemetryRetentionDays = {};
  for (const key of PROJECT_RETENTION_KEYS) {
    const v = stored?.[key];
    if (v !== undefined && v !== null && Number.isFinite(Number(v))) out[key] = clampRetentionDays(v, DEFAULT_RETENTION_DAYS[key]);
  }
  return out;
}

export type RetentionPatch = Partial<Record<keyof TelemetryRetentionDays, number | null>>;

/**
 * PUT /privacy/retention body. Per key: an integer 1..365 sets an override, null (or "")
 * clears it (back to the default), omitted leaves it unchanged. traces/profiles accept only
 * null: their retention is cluster-wide.
 */
export function parseRetentionPatch(body: unknown): { ok: true; value: RetentionPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const src = body as Record<string, unknown>;
  const out: RetentionPatch = {};
  for (const key of CLUSTER_RETENTION_KEYS) {
    if (src[key] === undefined) continue;
    if (src[key] === null || src[key] === '') { out[key] = null; continue; }
    return {
      ok: false,
      error: `${key} retention is cluster-wide (TELEMETRY_RETENTION_DAYS, set with platformctl); per-project ${key} retention is not supported`,
    };
  }
  for (const key of PROJECT_RETENTION_KEYS) {
    if (src[key] === undefined) continue;
    if (src[key] === null || src[key] === '') { out[key] = null; continue; }
    const n = Number(src[key]);
    if (typeof src[key] === 'boolean' || !Number.isInteger(n) || n < DAY_MIN || n > DAY_MAX) {
      return { ok: false, error: `${key} must be an integer ${DAY_MIN}..${DAY_MAX}, or null to use the default` };
    }
    out[key] = n;
  }
  return { ok: true, value: out };
}

/** New stored overrides after a patch (null removes the key; cluster-only keys are dropped). */
export function applyRetentionPatch(stored: TelemetryRetentionDays | null | undefined, patch: RetentionPatch): TelemetryRetentionDays {
  const next: TelemetryRetentionDays = { ...retentionOverrides(stored) };
  for (const key of PROJECT_RETENTION_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined) delete next[key];
    else next[key] = v;
  }
  return next;
}

export function parseConsentDefaultsPatch(body: unknown): { ok: true; value: PrivacyConsentDefaults } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const src = body as Record<string, unknown>;
  return {
    ok: true,
    value: {
      replay: src.replay === undefined ? DEFAULT_CONSENT.replay : !!src.replay,
      analytics: src.analytics === undefined ? DEFAULT_CONSENT.analytics : !!src.analytics,
    },
  };
}

export function parseScrubRulesPatch(body: unknown): { ok: true; rules: ScrubRule[]; scrubIps?: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const src = body as Record<string, unknown>;
  const scrubIps = src.scrubIps === undefined ? undefined : !!src.scrubIps;
  if (src.rules === undefined) return { ok: true, rules: [], scrubIps };
  if (!Array.isArray(src.rules)) return { ok: false, error: 'rules must be an array' };
  if (src.rules.length > 50) return { ok: false, error: 'at most 50 custom rules' };
  const rules: ScrubRule[] = [];
  const seen = new Set<string>();
  for (const raw of src.rules) {
    const v = validateScrubRule(raw);
    if (v.ok === false) return { ok: false, error: v.error };
    if (seen.has(v.rule.id)) return { ok: false, error: `duplicate rule id: ${v.rule.id}` };
    seen.add(v.rule.id);
    rules.push(v.rule);
  }
  return { ok: true, rules, scrubIps };
}

export async function getOrCreatePrivacySettings(
  ds: DataSource,
  projectId: string,
): Promise<TelemetryPrivacySettings> {
  const repo = ds.getRepository(TelemetryPrivacySettings);
  let row = await repo.findOne({ where: { projectId } });
  if (row) return row;
  row = repo.create({
    projectId,
    scrubRules: [],
    scrubIps: true,
    retentionDays: {},
    consentDefaults: { ...DEFAULT_CONSENT },
    updatedById: null,
  });
  return repo.save(row);
}

export function scrubOptionsFromSettings(settings: TelemetryPrivacySettings | null | undefined): ScrubOptions {
  return {
    scrubIps: settings?.scrubIps !== false,
    extraRules: settings?.scrubRules || [],
    target: 'logs',
  };
}

/** Where each retention type is enforced: per project, or cluster-wide only. */
export const RETENTION_SCOPE = {
  logs: 'project', replays: 'project', errors: 'project', heatmaps: 'project', traces: 'cluster', profiles: 'cluster',
} as const;

export function publicPrivacySettings(row: TelemetryPrivacySettings) {
  return {
    projectId: row.projectId,
    scrubIps: row.scrubIps,
    scrubRules: row.scrubRules || [],
    retentionDays: mergeRetention(row.retentionDays),
    /** Project overrides only; a missing key means the default applies. */
    retentionOverrides: retentionOverrides(row.retentionDays),
    retentionScope: RETENTION_SCOPE,
    consentDefaults: {
      replay: row.consentDefaults?.replay ?? DEFAULT_CONSENT.replay,
      analytics: row.consentDefaults?.analytics ?? DEFAULT_CONSENT.analytics,
    },
    defaults: {
      retentionDays: defaultRetentionDays(),
      consent: { ...DEFAULT_CONSENT },
    },
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
  };
}
