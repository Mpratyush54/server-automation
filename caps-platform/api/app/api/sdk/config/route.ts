import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/config/database';
import { Project } from '@/entities/Project';
import { ProjectConfig } from '@/entities/ProjectConfig';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const environmentId = searchParams.get('environmentId');

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    const ds = await getDb();
    const projectRepo = ds.getRepository(Project);

    let resolvedProjectId = projectId;
    const project = await projectRepo.findOne({ where: { name: projectId } });
    if (project) {
      resolvedProjectId = project.id;
    }

    const repo = ds.getRepository(ProjectConfig);
    const configs = await repo.find({
      where: {
        projectId: resolvedProjectId,
        environmentId: environmentId || null,
      },
    });

    const result: Record<string, string> = {};
    for (const cfg of configs) {
      result[cfg.key] = cfg.isSecret ? '***' : cfg.value;
    }

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
