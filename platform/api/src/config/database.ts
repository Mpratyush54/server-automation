import { ErrorIssue } from '../entities/ErrorIssue';
import 'reflect-metadata';
import path from 'path';
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
import { BackgroundJob } from '../entities/BackgroundJob';
import { Operation } from '../entities/Operation';
import { OperationStep } from '../entities/OperationStep';
import { OutboxMessage } from '../entities/OutboxMessage';
import { WebhookDelivery } from '../entities/WebhookDelivery';
import { IdempotencyKey } from '../entities/IdempotencyKey';
import { UserMfa } from '../entities/UserMfa';
import { MfaRecoveryCode } from '../entities/MfaRecoveryCode';
import { GitProviderApp } from '../entities/GitProviderApp';
import { GitAppInstallation } from '../entities/GitAppInstallation';
import { ALERTING_ENTITIES } from '../entities/alerting-entities';
import { TelemetryPrivacySettings } from '../entities/TelemetryPrivacySettings';
import { TelemetryConsent } from '../entities/TelemetryConsent';

export const MIGRATIONS_TABLE = 'migrations';

/** src/migrations/*.ts under ts-node/jest, dist/migrations/*.js in the image. */
export function migrationsGlob(baseDir: string = path.join(__dirname, '..', 'migrations')): string {
  const ext = __filename.endsWith('.ts') ? 'ts' : 'js';
  return `${baseDir.replace(/\\/g, '/')}/*.${ext}`;
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  username: process.env.POSTGRES_USER || 'plat',
  password: process.env.POSTGRES_PASSWORD || 'plat',
  database: process.env.POSTGRES_DB || 'plat_platform',
  entities: [ErrorIssue, Project, Environment, Deployment, ServiceRegistration, ProjectConfig, File, Alert, DbConnection, User, Role, AuditLog, ClickupTaskLink, SdkCredential, DbBackup, SmtpConfig, StorageProvider, Secret, SecretVersion, ProjectMember, AgentToken, AgentCommandApproval, IntegrationSettings, Notification, BackgroundJob,
    // Coordination (#23): operations step log, outbox, webhook dedupe, idempotency.
    Operation, OperationStep, OutboxMessage, WebhookDelivery, IdempotencyKey,
    // MFA (#24): TOTP factor + single-use recovery codes.
    UserMfa, MfaRecoveryCode,
    // Automated Git provider connect (#35): GitHub App / GitLab OAuth app + installations.
    GitProviderApp, GitAppInstallation,
    // Telemetry privacy (#47): scrubbing/retention settings + subject consent for replay (#40).
    TelemetryPrivacySettings, TelemetryConsent,
    // Alerting and on-call (#43).
    ...ALERTING_ENTITIES],
  // Schema changes ship as reviewed, versioned migrations (src/migrations),
  // applied once per release by `node dist/migrate.js` (the platform-api-migrate
  // Job) before the API rolls. Never auto-sync: it silently drops columns and
  // races between replicas.
  synchronize: false,
  migrationsRun: false,
  migrations: [migrationsGlob()],
  migrationsTableName: MIGRATIONS_TABLE,
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
