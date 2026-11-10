import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';

export interface UploadResult {
  fileId: string;
  url?: string;
}

export interface StorageAdapter {
  upload(filePath: string, remoteName: string, metadata?: Record<string, string>): Promise<UploadResult>;
  download(fileId: string, destPath: string): Promise<void>;
  delete(fileId: string): Promise<void>;
  testConnection(): Promise<boolean>;
}

// ──── Local/MinIO Adapter ────────────────────────────────────────────────────
export class LocalAdapter implements StorageAdapter {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = path.resolve(basePath || process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
    if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
  }

  private resolve(fileId: string): string {
    const resolved = path.resolve(this.basePath, fileId);
    const relative = path.relative(this.basePath, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid backup path');
    return resolved;
  }

  async upload(filePath: string, remoteName: string): Promise<UploadResult> {
    const dest = this.resolve(remoteName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);
    return { fileId: remoteName };
  }

  async download(fileId: string, destPath: string): Promise<void> {
    fs.copyFileSync(this.resolve(fileId), destPath);
  }

  async delete(fileId: string): Promise<void> {
    const p = this.resolve(fileId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async testConnection(): Promise<boolean> {
    return fs.existsSync(this.basePath);
  }
}

// ──── S3 Adapter ────────────────────────────────────────────────────────────
export function storageConnectionError(err: any): string {
  const name = err?.name || err?.Code || '';
  if (/NoSuchBucket|NotFound/.test(name)) return 'Bucket not found. Check the bucket name and region.';
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|InvalidToken/.test(name)) return 'Authentication failed. Check the access key, secret and region.';
  if (/AccessDenied|Forbidden/.test(name) || err?.$metadata?.httpStatusCode === 403) return 'Access denied. Grant put, get and delete permissions on this bucket.';
  if (/ENOTFOUND|ECONNREFUSED|Timeout|Abort|Networking|EAI_AGAIN/.test(name + ' ' + (err?.code || '') + ' ' + (err?.cause?.code || ''))) return 'Endpoint unreachable or timed out. Check the endpoint and network.';
  if (/PermanentRedirect|AuthorizationHeaderMalformed/.test(name)) return 'Wrong endpoint or region. Check the bucket region.';
  return 'Storage request failed. Check endpoint, TLS, region and bucket permissions.';
}

export class S3Adapter implements StorageAdapter {
  constructor(private config: Record<string, string>, private bucketName: string) {}
  private async sdk() {
    const cmd = await import('@aws-sdk/client-s3');
    const client = new cmd.S3Client({
      region: this.config.region || 'us-east-1', endpoint: this.config.endpoint || undefined,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      forcePathStyle: this.config.forcePathStyle ? this.config.forcePathStyle === 'true' : !!this.config.endpoint,
      maxAttempts: 1,
    });
    return { cmd, client };
  }
  async upload(filePath: string, remoteName: string): Promise<UploadResult> {
    const { cmd, client } = await this.sdk();
    try {
      await client.send(new cmd.PutObjectCommand({ Bucket: this.bucketName, Key: remoteName, Body: fs.createReadStream(filePath) }));
      return { fileId: remoteName, url: `s3://${this.bucketName}/${remoteName}` };
    } finally { client.destroy(); }
  }
  async download(fileId: string, destPath: string): Promise<void> {
    const { cmd, client } = await this.sdk();
    try {
      const res = await client.send(new cmd.GetObjectCommand({ Bucket: this.bucketName, Key: fileId }));
      const { pipeline } = await import('stream/promises');
      await pipeline(res.Body as stream.Readable, fs.createWriteStream(destPath));
    } finally { client.destroy(); }
  }
  async delete(fileId: string): Promise<void> {
    const { cmd, client } = await this.sdk();
    try { await client.send(new cmd.DeleteObjectCommand({ Bucket: this.bucketName, Key: fileId })); }
    finally { client.destroy(); }
  }
  async testConnection(): Promise<boolean> {
    const { cmd, client } = await this.sdk();
    const key = `__platform_probe/${require('crypto').randomUUID()}`;
    const payload = require('crypto').randomUUID();
    let stage = 'put';
    let failure: Error | undefined;
    let written = false;
    try {
      await client.send(new cmd.PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: payload }), { abortSignal: AbortSignal.timeout(10000) });
      written = true;
      stage = 'get';
      const result = await client.send(new cmd.GetObjectCommand({ Bucket: this.bucketName, Key: key }), { abortSignal: AbortSignal.timeout(10000) });
      if (await result.Body?.transformToString() !== payload) throw new Error('ProbeMismatch');
    } catch (err) { failure = new Error(`${stage}: ${storageConnectionError(err)}`); }
    finally {
      try {
        await client.send(new cmd.DeleteObjectCommand({ Bucket: this.bucketName, Key: key }), { abortSignal: AbortSignal.timeout(10000) });
      } catch (err) {
        if (written || !failure) failure = new Error(`${failure ? failure.message + ' ' : ''}delete: ${storageConnectionError(err)} Probe cleanup failed.`);
      }
      client.destroy();
    }
    if (failure) throw failure;
    return true;
  }
}

export class GoogleDriveAdapter implements StorageAdapter {
  private config: Record<string, string>;

  constructor(config: Record<string, string>) {
    this.config = config;
  }

  private async getClient() {
    const { google } = await import('googleapis' as any);
    const auth = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
    );
    auth.setCredentials({ refresh_token: this.config.refreshToken });
    return google.drive({ version: 'v3', auth });
  }

  private async getOrCreateFolder(drive: any, folderName: string, parentId?: string): Promise<string> {
    const query = [`name = '${folderName}'`, `mimeType = 'application/vnd.google-apps.folder'`];
    if (parentId) query.push(`'${parentId}' in parents`);
    const res = await drive.files.list({ q: query.join(' and '), fields: 'files(id, name)' });
    if (res.data.files.length > 0) return res.data.files[0].id;
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      },
      fields: 'id',
    });
    return folder.data.id;
  }

  async upload(filePath: string, remoteName: string): Promise<UploadResult> {
    const drive = await this.getClient();
    const rootFolderId = await this.getOrCreateFolder(drive, 'plat_platform_BACKUPS');
    const parts = remoteName.split('/');
    let parentId = rootFolderId;
    for (let i = 0; i < parts.length - 1; i++) {
      parentId = await this.getOrCreateFolder(drive, parts[i], parentId);
    }
    const fileName = parts[parts.length - 1];
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { body: fs.createReadStream(filePath) },
      fields: 'id, webViewLink',
    });
    return { fileId: res.data.id, url: res.data.webViewLink };
  }

  async download(fileId: string, destPath: string): Promise<void> {
    const drive = await this.getClient();
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async delete(fileId: string): Promise<void> {
    const drive = await this.getClient();
    await drive.files.delete({ fileId });
  }

  async testConnection(): Promise<boolean> {
    try {
      const drive = await this.getClient();
      await drive.about.get({ fields: 'user' });
      return true;
    } catch { return false; }
  }
}

// ──── Default backup target ──────────────────────────────────────────────────
export const DEFAULT_BACKUP_BUCKET = 'platform-backups';

/**
 * Where backups go when no storage provider is marked default:
 *  - BACKUP_STORAGE=local|minio|s3 forces one;
 *  - otherwise the bundled MinIO (MINIO_ENDPOINT, set by platformctl), bucket
 *    BACKUP_BUCKET (default platform-backups), or any S3-compatible target via
 *    BACKUP_S3_ENDPOINT / BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY / BACKUP_S3_REGION;
 *  - LocalAdapter (BACKUP_DIR) only when no object store is configured (dev).
 */
export function defaultBackupProviderType(env: NodeJS.ProcessEnv = process.env): 'minio' | 's3' | 'local' {
  const forced = (env.BACKUP_STORAGE || '').toLowerCase();
  if (forced === 'local' || forced === 'minio' || forced === 's3') return forced;
  if (env.BACKUP_S3_ENDPOINT) return 's3';
  if (env.MINIO_ENDPOINT) return 'minio';
  return 'local';
}

export function createDefaultBackupAdapter(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const type = defaultBackupProviderType(env);
  if (type === 'local') return new LocalAdapter();
  const s3 = type === 's3';
  const endpoint = s3 ? env.BACKUP_S3_ENDPOINT || '' : env.MINIO_ENDPOINT || 'http://minio.storage:9000';
  return new S3Adapter(
    {
      endpoint,
      region: (s3 ? env.BACKUP_S3_REGION : '') || 'us-east-1',
      accessKeyId: (s3 ? env.BACKUP_S3_ACCESS_KEY : (env.MINIO_API_ACCESS_KEY || env.MINIO_ACCESS_KEY)) || '',
      secretAccessKey: (s3 ? env.BACKUP_S3_SECRET_KEY : (env.MINIO_API_SECRET_KEY || env.MINIO_SECRET_KEY)) || '',
    },
    env.BACKUP_BUCKET || DEFAULT_BACKUP_BUCKET,
  );
}

// ──── Storage Router ─────────────────────────────────────────────────────────
export function createAdapter(
  providerType: string,
  credentials: Record<string, string>,
  bucketName?: string,
  endpointUrl?: string
): StorageAdapter {
  switch (providerType) {
    case 'google_drive': return new GoogleDriveAdapter(credentials);
    case 's3': return new S3Adapter({ ...credentials, endpoint: endpointUrl || '' }, bucketName || 'plat-backups');
    case 'minio': return new S3Adapter({ ...credentials, endpoint: endpointUrl || 'http://minio:9000' }, bucketName || 'plat-backups');
    case 'local': return new LocalAdapter(credentials.basePath);
    default: throw new Error('Unsupported storage provider');
  }
}
