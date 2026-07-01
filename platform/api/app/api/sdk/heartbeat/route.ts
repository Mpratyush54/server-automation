import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/config/database';
import { connectMongo } from '@/config/mongoose';
import { ServiceRegistration } from '@/entities/ServiceRegistration';
import { DbConnection, DbConnectionStatus, DbType } from '@/entities/DbConnection';
import { Project } from '@/entities/Project';
import { MetricsRawModel } from '@/schemas/MetricsRaw';
import { healthCheckAll } from '@/config/connections';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const ds = await getDb();
    const regRepo = ds.getRepository(ServiceRegistration);

    let registration = await regRepo.findOne({ where: { id: body.registrationId } });
    if (!registration && body.projectId) {
      const project = await ds.getRepository(Project).findOne({ where: { name: body.projectId } });
      if (project) {
        registration = await regRepo.findOne({ where: { projectId: project.id } });
      }
    }

    if (!registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
    }

    registration.lastSeen = new Date();
    registration.status = 'online';
    await regRepo.save(registration);

    if (body.dbHealth) {
      const dbRepo = ds.getRepository(DbConnection);
      for (const [dbType, health] of Object.entries(body.dbHealth) as [string, any][]) {
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
        conn.status = health.status === 'connected' ? DbConnectionStatus.CONNECTED
          : health.status === 'degraded' ? DbConnectionStatus.DEGRADED
          : DbConnectionStatus.DISCONNECTED;
        conn.lastHeartbeat = new Date();
        conn.activeCount = health.activeCount ?? conn.activeCount;
        conn.idleCount = health.idleCount ?? conn.idleCount;
        conn.metrics = health;
        await dbRepo.save(conn);
      }
    }

    await connectMongo();
    await MetricsRawModel.create({
      registrationId: registration.id,
      projectId: registration.projectId,
      environment: body.environment || registration.environmentId || 'development',
      cpuPct: body.cpu,
      memoryMb: body.memory,
      heapMb: body.heapMb,
      uptimeS: body.uptimeS,
      requestCount: body.requestCount,
      avgResponseMs: body.avgResponseMs,
      p95ResponseMs: body.p95ResponseMs,
      errors4xx: body.errors4xx,
      errors5xx: body.errors5xx,
      dbHealth: body.dbHealth || {},
      timestamp: new Date(),
    });

    let dbHealthStatus: Record<string, any> = {};
    try {
      const healthResults = await healthCheckAll();
      for (const h of healthResults) {
        dbHealthStatus[h.type] = { status: h.status, latencyMs: h.latencyMs };
      }
    } catch {}

    return NextResponse.json({ ok: true, dbHealth: dbHealthStatus });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
