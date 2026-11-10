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

export function mergeRetention(partial?: TelemetryRetentionDays | null): Required<TelemetryRetentionDays> {
  return {
    logs: clampRetentionDays(partial?.logs, DEFAULT_RETENTION_DAYS.logs),
    traces: clampRetentionDays(partial?.traces, DEFAULT_RETENTION_DAYS.traces),
    profiles: clampRetentionDays(partial?.profiles, DEFAULT_RETENTION_DAYS.profiles),
    replays: clampRetentionDays(partial?.replays, DEFAULT_RETENTION_DAYS.replays),
    errors: clampRetentionDays(partial?.errors, DEFAULT_RETENTION_DAYS.errors),
    heatmaps: clampRetentionDays(partial?.heatmaps, DEFAULT_RETENTION_DAYS.heatmaps),
  };
}

export function parseRetentionPatch(body: unknown): { ok: true; value: TelemetryRetentionDays } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const src = body as Record<string, unknown>;
  const out: TelemetryRetentionDays = {};
  for (const key of ['logs', 'traces', 'profiles', 'replays', 'errors', 'heatmaps'] as const) {
    if (src[key] === undefined) continue;
    const n = Number(src[key]);
    if (!Number.isFinite(n) || n < DAY_MIN || n > DAY_MAX) {
      return { ok: false, error: `${key} must be an integer ${DAY_MIN}..${DAY_MAX}` };
    }
    out[key] = Math.floor(n);
  }
  return { ok: true, value: out };
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

export function publicPrivacySettings(row: TelemetryPrivacySettings) {
  return {
    projectId: row.projectId,
    scrubIps: row.scrubIps,
    scrubRules: row.scrubRules || [],
    retentionDays: mergeRetention(row.retentionDays),
    consentDefaults: {
      replay: row.consentDefaults?.replay ?? DEFAULT_CONSENT.replay,
      analytics: row.consentDefaults?.analytics ?? DEFAULT_CONSENT.analytics,
    },
    defaults: {
      retentionDays: { ...DEFAULT_RETENTION_DAYS },
      consent: { ...DEFAULT_CONSENT },
    },
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
  };
}
