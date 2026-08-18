import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Project } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { Deployment } from '../entities/Deployment';
import { ServiceRegistration } from '../entities/ServiceRegistration';
import { ProjectConfig } from '../entities/ProjectConfig';
import { File } from '../entities/File';
import { Alert } from '../entities/Alert';
import { DbConnection } from '../entities/DbConnection';
import { User } from '../entities/User';
import { Role } from '../entities/Role';
import { AuditLog } from '../entities/AuditLog';
import { ClickupTaskLink } from '../entities/ClickupTaskLink';
import { SdkCredential } from '../entities/SdkCredential';
import { DbBackup } from '../entities/DbBackup';
import { SmtpConfig } from '../entities/SmtpConfig';
import { StorageProvider } from '../entities/StorageProvider';
import { Secret } from '../entities/Secret';
import { SecretVersion } from '../entities/SecretVersion';
import { ProjectMember } from '../entities/ProjectMember';
import { AgentToken } from '../entities/AgentToken';
import { AgentCommandApproval } from '../entities/AgentCommandApproval';
import { IntegrationSettings } from '../entities/IntegrationSettings';
import { Notification } from '../entities/Notification';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  username: process.env.POSTGRES_USER || 'plat',
  password: process.env.POSTGRES_PASSWORD || 'plat',
  database: process.env.POSTGRES_DB || 'plat_platform',
  entities: [Project, Environment, Deployment, ServiceRegistration, ProjectConfig, File, Alert, DbConnection, User, Role, AuditLog, ClickupTaskLink, SdkCredential, DbBackup, SmtpConfig, StorageProvider, Secret, SecretVersion, ProjectMember, AgentToken, AgentCommandApproval, IntegrationSettings, Notification],
  synchronize: true,
  logging: false,
});

let initialized = false;

export function isPostgresAuthError(err: unknown): boolean {
  const anyErr = err as { message?: string; code?: string } | undefined;
  const msg = String(anyErr?.message || err || '');
  const code = String(anyErr?.code || '');
  return code === '28P01' || /password authentication failed/i.test(msg);
}

export async function reconnectPostgres(password: string): Promise<DataSource> {
  process.env.POSTGRES_PASSWORD = password;
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  initialized = false;
  const opts = AppDataSource.options as { password?: string; username?: string; host?: string; database?: string; port?: number };
  opts.password = password;
  if (process.env.POSTGRES_USER) opts.username = process.env.POSTGRES_USER;
  if (process.env.POSTGRES_HOST) opts.host = process.env.POSTGRES_HOST;
  if (process.env.POSTGRES_DB) opts.database = process.env.POSTGRES_DB;
  if (process.env.POSTGRES_PORT) opts.port = parseInt(process.env.POSTGRES_PORT, 10);
  await AppDataSource.initialize();
  initialized = true;
  return AppDataSource;
}

export async function getDb() {
  if (initialized && AppDataSource.isInitialized) {
    return AppDataSource;
  }
  try {
    if (!AppDataSource.isInitialized) {
      if (process.env.POSTGRES_PASSWORD) {
        (AppDataSource.options as { password?: string }).password = process.env.POSTGRES_PASSWORD;
      }
      await AppDataSource.initialize();
    }
    initialized = true;
    return AppDataSource;
  } catch (err) {
    if (!isPostgresAuthError(err)) throw err;
    const { recoverPostgresAuth } = await import('../lib/credential-recover');
    const recovered = await recoverPostgresAuth();
    if (!recovered.ok || !AppDataSource.isInitialized) throw err;
    initialized = true;
    return AppDataSource;
  }
}
