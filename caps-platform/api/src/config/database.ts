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

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  username: process.env.POSTGRES_USER || 'caps',
  password: process.env.POSTGRES_PASSWORD || 'caps',
  database: process.env.POSTGRES_DB || 'caps_platform',
  entities: [Project, Environment, Deployment, ServiceRegistration, ProjectConfig, File, Alert, DbConnection, User, Role, AuditLog, ClickupTaskLink, SdkCredential, DbBackup, SmtpConfig, StorageProvider],
  synchronize: process.env.NODE_ENV !== 'production',
  logging: false,
});

let initialized = false;

export async function getDb() {
  if (!initialized) {
    await AppDataSource.initialize();
    initialized = true;
  }
  return AppDataSource;
}
