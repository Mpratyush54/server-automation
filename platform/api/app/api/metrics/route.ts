import { NextRequest, NextResponse } from 'next/server';
import { healthCheckAll } from '@/config/connections';
import mongoose from 'mongoose';

const MetricsRawSchema = new mongoose.Schema(
  {
    registrationId: String,
    projectId: { type: String, required: true },
    environment: String,
    cpuPct: Number,
    memoryMb: Number,
    heapMb: Number,
    uptimeS: Number,
    requestCount: Number,
    avgResponseMs: Number,
    p95ResponseMs: Number,
    errors4xx: Number,
    errors5xx: Number,
    dbHealth: { type: mongoose.Schema.Types.Mixed },
    dbHealthServer: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: 'metrics_raw' }
);

function getMetricsModel() {
  const conn = mongoose.connection;
  if (conn.readyState !== 1) {
    throw new Error('MongoDB not connected');
  }
  return conn.models.MetricsRaw || mongoose.model('MetricsRaw', MetricsRawSchema);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    let dbHealthServer: any = null;
    try {
      dbHealthServer = await healthCheckAll();
    } catch {
      dbHealthServer = null;
    }

    const MetricsModel = getMetricsModel();

    const doc = await MetricsModel.create({
      registrationId: body.registrationId || null,
      projectId: body.projectId || 'unknown',
      environment: body.environment || 'development',
      cpuPct: body.cpuPct ?? 0,
      memoryMb: body.memoryMb ?? 0,
      heapMb: body.heapMb ?? 0,
      uptimeS: body.uptimeS ?? 0,
      requestCount: body.requestCount ?? 0,
      avgResponseMs: body.avgResponseMs ?? 0,
      p95ResponseMs: body.p95ResponseMs ?? 0,
      errors4xx: body.errors4xx ?? 0,
      errors5xx: body.errors5xx ?? 0,
      dbHealth: body.dbHealth || {},
      dbHealthServer,
      timestamp: new Date(),
    });

    return NextResponse.json({ stored: true, id: doc._id });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
