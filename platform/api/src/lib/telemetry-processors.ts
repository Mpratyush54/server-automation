import { processErrorEvent } from './error-tracking';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { ServiceRegistration } from '../entities/ServiceRegistration';
import { DbConnection, DbConnectionStatus, DbType } from '../entities/DbConnection';
import { LogModel } from '../schemas/Log';
import { ErrorDocModel } from '../schemas/ErrorDoc';
import { MetricsRawModel } from '../schemas/MetricsRaw';
import { ApiMetricModel } from '../schemas/ApiMetric';
import { forwardToLoki } from './lokilog';

/**
 * Destinations for SDK telemetry that still arrives at the API (POST /sdk/logs,
 * /logs/ingest, /sdk/api-metrics, /sdk/heartbeat). Called inline (memory state mode,
 * TELEMETRY_QUEUE=off, Redis outage) or by the leader's queue consumer
 * (lib/telemetry-queue.ts). Payloads are JSON-safe: timestamps may be ISO strings.
 * Every processor must tolerate being re-run for the same event (at-least-once delivery).
 */

export type TelemetryKind = 'logs' | 'api-metrics' | 'heartbeat' | 'errors';

export interface LogDoc {
  projectId: string;
  environment: string;
  branch: string;
  commitSha: string;
  hostname: string;
  level: string;
  message: unknown;
  fields: Record<string, any>;
  timestamp: string | Date;
}

export interface ApiMetricDoc {
  projectId: string;
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  memoryDeltaBytes: number;
  sdkVersion?: string;
  environment: string;
  timestamp: string | Date;
}

export interface HeartbeatEvent {
  projectId: string;
  body: Record<string, any>;
  receivedAt: string | Date;
}

const asDate = (v: string | Date | undefined): Date => {
  const d = v instanceof Date ? v : new Date(v ?? Date.now());
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

export async function processLogs(docs: LogDoc[]): Promise<void> {
  if (docs.length === 0) return;
  await connectMongo();
  const resolved = docs.map((d) => ({ ...d, timestamp: asDate(d.timestamp) }));
  await LogModel.insertMany(resolved);
  await forwardToLoki(resolved);

  // Error tracking
  for (const err of resolved.filter((log) => log.level === 'ERROR')) {
    const stackHash = err.fields?.stackHash || err.message;
    await ErrorDocModel.findOneAndUpdate(
      { projectId: err.projectId, errorType: err.fields?.errorType || 'UnknownError', stackHash },
      {
        $set: { environment: err.environment, message: err.message, lastSeen: new Date() },
        $inc: { occurrenceCount: 1 },
        $setOnInsert: { firstSeen: new Date() },
      },
      { upsert: true },
    );
  }
}

export async function processApiMetrics(docs: ApiMetricDoc[]): Promise<void> {
  if (docs.length === 0) return;
  await connectMongo();
  await ApiMetricModel.insertMany(docs.map((d) => ({ ...d, timestamp: asDate(d.timestamp) })));
}

export async function processHeartbeat(ev: HeartbeatEvent): Promise<void> {
  const body = ev.body || {};
  const tokenProjectId = ev.projectId;
  const seenAt = asDate(ev.receivedAt);
  const ds = await getDb();
  const regRepo = ds.getRepository(ServiceRegistration);

  // Lookup registration — always constrained to the token's project
  let registration: ServiceRegistration | null = null;
  if (body.registrationId && typeof body.registrationId === 'string') {
    registration = await regRepo.findOne({ where: { id: body.registrationId, projectId: tokenProjectId } });
    if (registration && registration.projectId !== tokenProjectId) registration = null;
  }
  if (!registration) {
    registration = await regRepo.findOne({ where: { projectId: tokenProjectId } });
    if (registration && registration.projectId !== tokenProjectId) registration = null;
  }

  if (registration) {
    registration.lastSeen = seenAt;
    registration.status = 'online';
    await regRepo.save(registration);
  }

  if (body.dbHealth && typeof body.dbHealth === 'object' && registration) {
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
      conn.status = health?.status === 'connected' ? DbConnectionStatus.CONNECTED : DbConnectionStatus.DISCONNECTED;
      conn.lastHeartbeat = seenAt;
      conn.activeCount = health?.activeCount ?? conn.activeCount;
      conn.idleCount = health?.idleCount ?? conn.idleCount;
      await dbRepo.save(conn);
    }
  }

  await connectMongo();
  await MetricsRawModel.create({
    registrationId: registration?.id || null,
    projectId: tokenProjectId,
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
    timestamp: seenAt,
  });
}

/** Process one event of `kind` (inline path, or the consumer's per-event retry). */
export async function processTelemetryEvent(kind: TelemetryKind, payload: any): Promise<void> {
  switch (kind) {
    case 'errors': return processErrorEvent(payload);
    case 'logs': return processLogs(payload as LogDoc[]);
    case 'api-metrics': return processApiMetrics(payload as ApiMetricDoc[]);
    case 'heartbeat': return processHeartbeat(payload as HeartbeatEvent);
    default: throw new Error(`unknown telemetry kind: ${String(kind)}`);
  }
}
