/**
 * GDPR subject delete across telemetry stores (#47).
 * Removes Mongo logs/errors, MinIO replay objects (prefix contract for #40),
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

/** Object-key prefix #40 must use so GDPR delete can remove a subject's replays. */
export function replayObjectPrefix(projectId: string, opts: { userId?: string; sessionId?: string }): string {
  if (opts.sessionId) return `replays/${projectId}/session/${opts.sessionId}/`;
  if (opts.userId) return `replays/${projectId}/user/${opts.userId}/`;
  return `replays/${projectId}/`;
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
 * Best-effort MinIO/S3 delete under the replay prefix. Uses AWS SDK v3 if present
 * via dynamic import of the upload store's S3 client helpers; otherwise no-ops
 * with a warning (replay storage lands in #40).
 */
async function deleteReplayObjects(
  projectId: string,
  userId: string | null,
  sessionId: string | null,
): Promise<{ count: number; warning?: string }> {
  const prefixes: string[] = [];
  if (userId) prefixes.push(replayObjectPrefix(projectId, { userId }));
  if (sessionId) prefixes.push(replayObjectPrefix(projectId, { sessionId }));
  if (!prefixes.length) return { count: 0 };

  const endpoint = process.env.REPLAYS_S3_ENDPOINT || process.env.MINIO_ENDPOINT || '';
  const bucket = process.env.REPLAYS_BUCKET || 'replays';
  const accessKeyId = process.env.REPLAYS_S3_ACCESS_KEY || process.env.MINIO_API_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || '';
  const secretAccessKey = process.env.REPLAYS_S3_SECRET_KEY || process.env.MINIO_API_SECRET_KEY || process.env.MINIO_SECRET_KEY || '';
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return { count: 0, warning: 'replay object store not configured; skipped MinIO delete' };
  }

  try {
    // Lazy require so unit tests without @aws-sdk still load the module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      endpoint,
      region: process.env.REPLAYS_S3_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    let count = 0;
    for (const prefix of prefixes) {
      let token: string | undefined;
      do {
        const listed = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        const keys = (listed.Contents || []).map((o: { Key?: string }) => o.Key).filter(Boolean) as string[];
        if (keys.length) {
          await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }));
          count += keys.length;
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
    }
    return { count };
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
  const start = process.env.GDPR_LOKI_DELETE_START || '0';
  const queries: string[] = [];
  if (userId) {
    queries.push(`{project_id="${projectId}"} |= "${userId.replace(/"/g, '')}"`);
  }
  if (sessionId) {
    queries.push(`{project_id="${projectId}"} |= "${sessionId.replace(/"/g, '')}"`);
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
  const consents = await deleteConsents(ds, req.projectId, userId, sessionId);
  const replays = await deleteReplayObjects(req.projectId, userId, sessionId);
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
      errors: mongo.errors,
      consents,
      replayObjects: replays.count,
      lokiRequests: loki.requests,
    },
    warnings,
  };
}
