import { Pool } from 'pg';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';

const adminPool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'postgres',
  max: 5,
});

export function generateSecurePassword(length = 32): string {
  return crypto.randomBytes(Math.ceil(length * 3 / 4)).toString('base64').slice(0, length).replace(/[+/]/g, 'X');
}

export function sanitizeDbName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 50);
}

export interface DbProvisionResult {
  dbName: string;
  username: string;
  password: string;
  host: string;
  port: number;
}

export async function provisionPostgresDb(projectName: string, environment: string, projectId?: string): Promise<DbProvisionResult> {
  if (!projectId) throw new Error('Immutable project ID is required for provisioning');
  const id = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 20);
  const envId = crypto.createHash('sha256').update(environment).digest('hex').slice(0, 12);
  const dbName = `plat_${id}_${envId}`;
  const username = `${dbName}_user`;
  const password = generateSecurePassword(32);

  const client = await adminPool.connect();
  try {
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
    if (!role.rows.length) await client.query(`CREATE ROLE ${client.escapeIdentifier(username)} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    else throw new Error('Database role already exists; use project credential resolution');
    const dbExists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!dbExists.rows.length) await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)} OWNER ${client.escapeIdentifier(username)}`);
    await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${client.escapeIdentifier(dbName)} TO ${client.escapeIdentifier(username)}`);

    return {
      dbName,
      username,
      password,
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    };
  } finally {
    client.release();
  }
}

export async function dropProjectDb(dbName: string, username: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    // Terminate active connections
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(dbName)}`);
    await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(username)}`);
  } finally {
    client.release();
  }
}

export async function dumpDatabase(
  dbName: string,
  outputPath: string
): Promise<{ success: boolean; error?: string; sizeBytes: number }> {
  return new Promise((resolve) => {
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = process.env.POSTGRES_PORT || '5432';
    const user = process.env.POSTGRES_USER || 'postgres';
    const password = process.env.POSTGRES_PASSWORD || 'postgres';

    const env = { ...process.env, PGPASSWORD: password };
    const pgdump = spawn('pg_dump', [
      '-Fc',
      '-h', host,
      '-p', port,
      '-U', user,
      '-d', dbName,
      '-f', outputPath
    ], { env });

    let stderr = '';
    pgdump.stderr.on('data', (d) => { stderr += d.toString(); });
    pgdump.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr, sizeBytes: 0 });
      } else {
        try {
          const stat = fs.statSync(outputPath);
          resolve({ success: true, sizeBytes: stat.size });
        } catch {
          resolve({ success: true, sizeBytes: 0 });
        }
      }
    });
    pgdump.on('error', (err) => resolve({ success: false, error: err.message, sizeBytes: 0 }));
  });
}

export async function restoreDatabase(
  dbName: string,
  backupFilePath: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise(async (resolve) => {
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = process.env.POSTGRES_PORT || '5432';
    const user = process.env.POSTGRES_USER || 'postgres';
    const password = process.env.POSTGRES_PASSWORD || 'postgres';

    try {
      await fs.promises.access(backupFilePath, fs.constants.R_OK);
      if (!(await fs.promises.stat(backupFilePath)).isFile() || !(await fs.promises.stat(backupFilePath)).size) {
        throw new Error('Backup is empty or not a regular file');
      }
    } catch (err: any) {
      resolve({ success: false, error: `Backup is not readable: ${err.message}` });
      return;
    }

    const env = { ...process.env, PGPASSWORD: password };
    const pgrestore = spawn('pg_restore', [
      '-h', host,
      '-p', port,
      '-U', user,
      '-d', dbName,
      '--clean', '--if-exists', '--single-transaction', '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      backupFilePath
    ], { env });

    let stderr = '';
    pgrestore.stderr.on('data', (d) => { stderr += d.toString(); });
    pgrestore.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr });
      } else {
        resolve({ success: true });
      }
    });
    pgrestore.on('error', (err) => resolve({ success: false, error: err.message }));
  });
}

export async function computeFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
