/**
 * GDPR subject delete across telemetry stores (#47).
 * Removes Mongo logs/errors, session replays (#40: objects + replay_sessions rows),
 * and submits Loki delete requests. Always writes an audit entry via the caller.
 */
import axios from 'axios';
import type { DataSource } from 'typeorm';
import { connectMongo } from '../config/mongoose';
import { ErrorDocModel } from '../schemas/ErrorDoc';
import { LogModel } from '../schemas/Log';
import { TelemetryConsent } from '../entities/TelemetryConsent';
import { invalidateConsentCache, normalizeSessionId, normalizeSubjectId } from './privacy-consent';
import { createHash } from 'crypto';
import { getReplayStore, replaySessionPrefix } from './replay-store';
import { deleteReplaysForSubject } from './replay-sessions';

export interface GdprDeleteRequest {
  projectId: string;
  /** Application user.id */
  userId?: string;
  /** Browser / replay session id */
  sessionId?: string;
  /** Optional email; only the SHA-256 hex is stored in the audit metadata. */
  email?: string;
}

export interface GdprDeleteResult {
  projectId: string;
  userId: string | null;
  sessionId: string | null;
  emailHash: string | null;
  deleted: {
    logs: number;
    errors: number;
    consents: number;
    replayObjects: number;
    lokiRequests: number;
  };
  warnings: string[];
}

function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Object-key prefix of a replay session (#40): `replays/<projectId>/<sessionId>/` in the
 * `replays` bucket. Replays of an application user are found through replay_sessions.
 */
export function replayObjectPrefix(projectId: string, opts: { sessionId: string }): string {
  return replaySessionPrefix(projectId, opts.sessionId);
}

async function deleteMongoBySubject(
  projectId: string,
  userId: string | null,
  sessionId: string | null,
): Promise<{ logs: number; errors: number }> {
  await connectMongo();
  const or: Record<string, unknown>[] = [];
  if (userId) {
    const re = new RegExp(escapeRegex(userId), 'i');
    or.push(
      { 'fields.userId': userId },
      { 'fields.user.id': userId },
      { 'fields.user_id': userId },
      { userId },
      { message: re },
    );
  }
  if (sessionId) {
    const re = new RegExp(escapeRegex(sessionId), 'i');
    or.push(
      { 'fields.sessionId': sessionId },
      { 'fields.session.id': sessionId },
      { 'fields.session_id': sessionId },
      { sessionId },
      { message: re },
    );
  }
  if (or.length === 0) return { logs: 0, errors: 0 };

  const logRes = await LogModel.deleteMany({ projectId, $or: or });
  const errRes = await ErrorDocModel.deleteMany({ projectId, $or: or });
  return {
    logs: logRes.deletedCount || 0,
    errors: errRes.deletedCount || 0,
  };
}

async function deleteConsents(
  ds: DataSource,
  projectId: string,
  userId: string | null,
  sessionId: string | null,
): Promise<number> {
  const repo = ds.getRepository(TelemetryConsent);
  const where: Array<{ projectId: string; subjectId?: string; sessionId?: string }> = [];
  if (userId) where.push({ projectId, subjectId: userId });
  if (sessionId) where.push({ projectId, sessionId });
  if (!where.length) return 0;
  let n = 0;
  for (const w of where) {
    const rows = await repo.find({ where: w as any });
    for (const row of rows) {
      await repo.delete(row.id);
      await invalidateConsentCache(projectId, row.subjectId, row.sessionId);
      n += 1;
    }
  }
  return n;
}

/**
 * Replays of the subject (#40): sessions matched by session id, user id or consent
 * subject id; deletes the objects under each session prefix and the metadata rows.
 */
async function deleteReplayObjects(
  ds: DataSource,
  projectId: string,
  userId: string | null,
  sessionId: string | null,
): Promise<{ count: number; warning?: string }> {
  if (!userId && !sessionId) return { count: 0 };
  const store = getReplayStore();
  try {
    const r = await deleteReplaysForSubject(ds, store, projectId, { userId, sessionId });
    return store ? { count: r.objects } : { count: 0, warning: 'replay object store not configured; skipped MinIO delete' };
  } catch (err: any) {
    return { count: 0, warning: `replay delete failed: ${err?.message || err}` };
  }
}

/** Submit Loki delete requests (compactor processes them asynchronously). */
export async function submitLokiDeletes(
  projectId: string,
  userId: string | null,
  sessionId: string | null,
): Promise<{ requests: number; warning?: string }> {
  const lokiUrl = (process.env.LOKI_URL || 'http://loki.monitoring.svc:3100').replace(/\/+$/, '');
  // Loki rejects start=0; an RFC3339 date before any retained data deletes everything older too.
  const start = process.env.GDPR_LOKI_DELETE_START || '2020-01-01T00:00:00Z';
  const queries: string[] = [];
  if (userId) {
    queries.push(`{platform_project_id="${projectId}"} |= "${lokiLiteral(userId)}"`);
  }
  if (sessionId) {
    queries.push(`{platform_project_id="${projectId}"} |= "${lokiLiteral(sessionId)}"`);
  }
  if (!queries.length) return { requests: 0 };

  let requests = 0;
  try {
    for (const query of queries) {
      await axios.post(
        `${lokiUrl}/loki/api/v1/delete`,
        null,
        { params: { query, start }, timeout: 5000, validateStatus: (s) => s >= 200 && s < 300 || s === 204 },
      );
      requests += 1;
    }
    return { requests };
  } catch (err: any) {
    return { requests, warning: `loki delete failed: ${err?.message || err}` };
  }
}

export async function runGdprDelete(
  ds: DataSource,
  req: GdprDeleteRequest,
): Promise<GdprDeleteResult> {
  const userId = req.userId ? normalizeSubjectId(req.userId) : null;
  const sessionId = req.sessionId ? normalizeSessionId(req.sessionId) || null : null;
  if (!userId && !sessionId) {
    throw new Error('userId or sessionId is required');
  }
  const warnings: string[] = [];
  const email = req.email ? String(req.email).trim() : '';
  const hash = email ? emailHash(email) : null;

  const mongo = await deleteMongoBySubject(req.projectId, userId, sessionId);
  // Error events from error tracking (#41) live in Postgres with the subject in the payload.
  const pgErrors = await deletePostgresErrorEvents(ds, req.projectId, userId, sessionId);
  const consents = await deleteConsents(ds, req.projectId, userId, sessionId);
  const replays = await deleteReplayObjects(ds, req.projectId, userId, sessionId);
  if (replays.warning) warnings.push(replays.warning);
  const loki = await submitLokiDeletes(req.projectId, userId, sessionId);
  if (loki.warning) warnings.push(loki.warning);

  return {
    projectId: req.projectId,
    userId,
    sessionId,
    emailHash: hash,
    deleted: {
      logs: mongo.logs,
      errors: mongo.errors + pgErrors,
      consents,
      replayObjects: replays.count,
      lokiRequests: loki.requests,
    },
    warnings,
  };
}

/** Loki line-filter literal: strip quotes and backslashes so the value cannot break out of the string. */
function lokiLiteral(v: string): string {
  return v.replace(/["\\]/g, '');
}

/** Delete #41 error events whose payload names the subject; issue aggregates keep only counts. */
export async function deletePostgresErrorEvents(
  ds: { query: (sql: string, params?: unknown[]) => Promise<any> },
  projectId: string,
  userId: string | null,
  sessionId: string | null,
): Promise<number> {
  if (!userId && !sessionId) return 0;
  try {
    const rows = await ds.query(
      `DELETE FROM error_events WHERE project_id = $1 AND (($2::text IS NOT NULL AND payload->>'userId' = $2) OR ($3::text IS NOT NULL AND payload->>'sessionId' = $3)) RETURNING id`,
      [projectId, userId, sessionId],
    );
    // TypeORM/pg returns [rows, affected] for DELETE ... RETURNING (or rows on other drivers).
    const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0; // table absent on installs without error tracking
  }
}
