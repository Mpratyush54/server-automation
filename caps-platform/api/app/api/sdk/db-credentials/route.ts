import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/config/database';
import { Project } from '@/entities/Project';
import { fetchSecrets } from '@/lib/infisical';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const dbTypes = searchParams.get('dbTypes')?.split(',') || [];

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

    const secrets = await fetchSecrets(resolvedProjectId, process.env.CAPS_ENV || 'development');

    const types = dbTypes.length > 0 ? dbTypes : ['postgres', 'mongo', 'redis'];
    const credentials: Record<string, any> = {};

    if (types.includes('postgres')) {
      credentials.postgres = {
        host: secrets.POSTGRES_HOST || process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(secrets.POSTGRES_PORT || process.env.POSTGRES_PORT || '5432', 10),
        user: secrets.POSTGRES_USER || process.env.POSTGRES_USER || 'caps',
        password: secrets.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'caps',
        database: secrets.POSTGRES_DB || process.env.POSTGRES_DB || 'caps_platform',
        poolSize: 10,
      };
    }

    if (types.includes('mongo')) {
      credentials.mongo = {
        uri: secrets.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/caps_platform',
        poolSize: 5,
      };
    }

    if (types.includes('redis')) {
      credentials.redis = {
        host: secrets.REDIS_HOST || process.env.REDIS_HOST || 'localhost',
        port: parseInt(secrets.REDIS_PORT || process.env.REDIS_PORT || '6379', 10),
        password: secrets.REDIS_PASSWORD || process.env.REDIS_PASSWORD || '',
      };
    }

    return NextResponse.json(credentials);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
