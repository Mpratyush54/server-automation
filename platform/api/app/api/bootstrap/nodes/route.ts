import { NextRequest, NextResponse } from 'next/server';
import { listNodes, isKubernetesConnected } from '@/config/kubernetes';

export async function GET(request: NextRequest) {
  try {
    if (!isKubernetesConnected()) {
      return NextResponse.json({ error: 'Kubernetes not connected', nodes: [] }, { status: 503 });
    }
    const nodes = await listNodes();
    return NextResponse.json({ nodes });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, nodes: [] }, { status: 500 });
  }
}
