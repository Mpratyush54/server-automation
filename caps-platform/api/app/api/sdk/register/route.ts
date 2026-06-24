import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/config/database';
import { connectMongo } from '@/config/mongoose';
import { Project, StackType } from '@/entities/Project';
import { Environment } from '@/entities/Environment';
import { ServiceRegistration } from '@/entities/ServiceRegistration';
import { DbConnection, DbConnectionStatus, DbType } from '@/entities/DbConnection';
import { SdkEventModel } from '@/schemas/SdkEvent';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const ds = await getDb();

    const projectRepo = ds.getRepository(Project);
    let project = await projectRepo.findOne({ where: { name: body.projectName } });
    if (!project) {
      project = projectRepo.create({
        name: body.projectName,
        stack: StackType.NODEJS,
      });
      project = await projectRepo.save(project);
    }

    const envRepo = ds.getRepository(Environment);
    let env = await envRepo.findOne({ where: { projectId: project.id, name: body.environmentName } });
    if (!env) {
      env = envRepo.create({
        name: body.environmentName as any,
        namespace: `${project.name}-${body.environmentName}`,
        domain: `${project.name}-${body.environmentName}.example.com`,
        projectId: project.id,
      });
      env = await envRepo.save(env);
    }

    const regRepo = ds.getRepository(ServiceRegistration);
    let registration = await regRepo.findOne({
      where: {
        projectId: project.id,
        environmentId: env.id,
        serviceName: body.serviceName || project.name,
      },
    });

    if (registration) {
      registration.hostname = body.hostname ?? registration.hostname;
      registration.ipAddress = body.ipAddress ?? registration.ipAddress;
      registration.version = body.version ?? registration.version;
      registration.branch = body.branch ?? registration.branch;
      registration.commitSha = body.commitSha ?? registration.commitSha;
      registration.infisicalProject = body.infisicalProject ?? registration.infisicalProject;
      registration.infisicalEnv = body.infisicalEnv ?? registration.infisicalEnv;
      registration.envKeys = body.envKeys ?? registration.envKeys;
      registration.dbTypes = body.dbTypes ?? registration.dbTypes;
      registration.metadata = body.metadata ?? registration.metadata;
      registration.lastSeen = new Date();
      registration.status = 'online';
    } else {
      registration = regRepo.create({
        projectId: project.id,
        environmentId: env.id,
        hostname: body.hostname || 'localhost',
        ipAddress: body.ipAddress || '127.0.0.1',
        serviceName: body.serviceName || project.name,
        version: body.version || '1.0.0',
        branch: body.branch || 'main',
        commitSha: body.commitSha || 'unknown',
        infisicalProject: body.infisicalProject || 'default',
        infisicalEnv: body.infisicalEnv || 'dev',
        envKeys: body.envKeys || [],
        dbTypes: body.dbTypes || [],
        status: 'online',
        metadata: body.metadata || {},
        lastSeen: new Date(),
      });
    }

    const saved = await regRepo.save(registration);

    if (body.dbTypes && Array.isArray(body.dbTypes)) {
      const dbRepo = ds.getRepository(DbConnection);
      for (const type of body.dbTypes) {
        let conn = await dbRepo.findOne({ where: { projectId: project.id, dbType: type as DbType } });
        if (!conn) {
          conn = dbRepo.create({
            registrationId: saved.id,
            projectId: project.id,
            dbType: type as DbType,
            poolSize: 10,
            status: DbConnectionStatus.CONNECTED,
            lastHeartbeat: new Date(),
          });
          await dbRepo.save(conn);
        }
      }
    }

    await connectMongo();
    await SdkEventModel.create({
      event: 'registration',
      registrationId: saved.id,
      projectId: project.id,
      payloadSummary: { serviceName: body.serviceName, hostname: body.hostname },
      timestamp: new Date(),
    });

    return NextResponse.json(saved, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
