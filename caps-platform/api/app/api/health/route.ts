import { NextRequest, NextResponse } from 'next/server';
import { healthCheckAll } from '@/config/connections';
import { getClusterHealth, isKubernetesConnected } from '@/config/kubernetes';

export async function GET(request: NextRequest) {
  const dbHealth = await healthCheckAll();
  const k8sHealth = isKubernetesConnected() ? await getClusterHealth() : null;

  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    databases: dbHealth,
    kubernetes: k8sHealth,
  });
}
