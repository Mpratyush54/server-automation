/**
 * Consent-aware replay hooks (#47). Session replay (#40) must call these before
 * uploading chunks or starting rrweb recording.
 */
import type { DataSource } from 'typeorm';
import {
  DEFAULT_CONSENT,
  PrivacyConsentDefaults,
  TelemetryPrivacySettings,
} from '../entities/TelemetryPrivacySettings';
import { TelemetryConsent } from '../entities/TelemetryConsent';
import { redisKey, stateBackend, withRedis } from './redis';

const SUBJECT_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9_.:-]{0,128}$/;

export function normalizeSubjectId(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return SUBJECT_RE.test(s) ? s : null;
}

export function normalizeSessionId(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return SESSION_RE.test(s) ? s : '';
}

export interface ConsentDecision {
  subjectId: string;
  sessionId: string;
  replayAllowed: boolean;
  analyticsAllowed: boolean;
  /** `recorded` when a TelemetryConsent row/cache hit; else `default`. */
  source: 'recorded' | 'default';
  defaults: PrivacyConsentDefaults;
}

function cacheKey(projectId: string, subjectId: string, sessionId: string): string {
  return redisKey(`privacy:consent:${projectId}:${subjectId}:${sessionId || '_'}`);
}

export async function getProjectConsentDefaults(
  ds: DataSource,
  projectId: string,
): Promise<PrivacyConsentDefaults> {
  const row = await ds.getRepository(TelemetryPrivacySettings).findOne({ where: { projectId } });
  return {
    replay: row?.consentDefaults?.replay ?? DEFAULT_CONSENT.replay,
    analytics: row?.consentDefaults?.analytics ?? DEFAULT_CONSENT.analytics,
  };
}

/**
 * Resolve whether replay/analytics are allowed for a subject (+ optional session).
 * Session-specific rows override subject-wide (`sessionId === ''`) rows; both
 * override project defaults.
 */
export async function resolveConsent(
  ds: DataSource,
  opts: { projectId: string; subjectId: string; sessionId?: string },
): Promise<ConsentDecision> {
  const subjectId = normalizeSubjectId(opts.subjectId);
  if (!subjectId) {
    const defaults = await getProjectConsentDefaults(ds, opts.projectId);
    return {
      subjectId: '',
      sessionId: '',
      replayAllowed: false,
      analyticsAllowed: defaults.analytics,
      source: 'default',
      defaults,
    };
  }
  const sessionId = normalizeSessionId(opts.sessionId);
  const defaults = await getProjectConsentDefaults(ds, opts.projectId);

  if (stateBackend() === 'redis') {
    try {
      const cached = await withRedis((r) => r.get(cacheKey(opts.projectId, subjectId, sessionId)));
      if (cached) {
        const parsed = JSON.parse(cached) as { replayAllowed: boolean; analyticsAllowed: boolean };
        return {
          subjectId,
          sessionId,
          replayAllowed: !!parsed.replayAllowed,
          analyticsAllowed: parsed.analyticsAllowed !== false,
          source: 'recorded',
          defaults,
        };
      }
    } catch { /* fall through to DB */ }
  }

  const repo = ds.getRepository(TelemetryConsent);
  let row = sessionId
    ? await repo.findOne({ where: { projectId: opts.projectId, subjectId, sessionId } })
    : null;
  if (!row) {
    row = await repo.findOne({ where: { projectId: opts.projectId, subjectId, sessionId: '' } });
  }
  if (!row) {
    return {
      subjectId,
      sessionId,
      replayAllowed: defaults.replay,
      analyticsAllowed: defaults.analytics,
      source: 'default',
      defaults,
    };
  }
  return {
    subjectId,
    sessionId,
    replayAllowed: row.replayAllowed,
    analyticsAllowed: row.analyticsAllowed,
    source: 'recorded',
    defaults,
  };
}

/** #40 must call this (or GET /sdk/privacy/consent) before starting rrweb. */
export async function isReplayAllowed(
  ds: DataSource,
  opts: { projectId: string; subjectId: string; sessionId?: string },
): Promise<boolean> {
  const d = await resolveConsent(ds, opts);
  return d.replayAllowed;
}

export async function upsertConsent(
  ds: DataSource,
  opts: {
    projectId: string;
    subjectId: string;
    sessionId?: string;
    replayAllowed?: boolean;
    analyticsAllowed?: boolean;
    source?: 'sdk' | 'portal' | 'api';
  },
): Promise<TelemetryConsent> {
  const subjectId = normalizeSubjectId(opts.subjectId);
  if (!subjectId) throw new Error('invalid subjectId');
  const sessionId = normalizeSessionId(opts.sessionId);
  const repo = ds.getRepository(TelemetryConsent);
  let row = await repo.findOne({ where: { projectId: opts.projectId, subjectId, sessionId } });
  if (!row) {
    row = repo.create({
      projectId: opts.projectId,
      subjectId,
      sessionId,
      replayAllowed: opts.replayAllowed ?? false,
      analyticsAllowed: opts.analyticsAllowed ?? true,
      source: opts.source ?? 'sdk',
    });
  } else {
    if (opts.replayAllowed !== undefined) row.replayAllowed = opts.replayAllowed;
    if (opts.analyticsAllowed !== undefined) row.analyticsAllowed = opts.analyticsAllowed;
    if (opts.source) row.source = opts.source;
  }
  const saved = await repo.save(row);
  if (stateBackend() === 'redis') {
    try {
      await withRedis((r) => r.set(
        cacheKey(opts.projectId, subjectId, sessionId),
        JSON.stringify({ replayAllowed: saved.replayAllowed, analyticsAllowed: saved.analyticsAllowed }),
        'EX',
        3600,
      ));
    } catch { /* cache is best-effort */ }
  }
  return saved;
}

/** Drop cached consent after GDPR delete / withdraw. */
export async function invalidateConsentCache(
  projectId: string,
  subjectId: string,
  sessionId = '',
): Promise<void> {
  if (stateBackend() !== 'redis') return;
  try {
    await withRedis((r) => r.del(cacheKey(projectId, subjectId, sessionId)));
  } catch { /* ignore */ }
}
