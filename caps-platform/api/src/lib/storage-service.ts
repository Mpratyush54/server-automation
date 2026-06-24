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
    this.basePath = basePath || path.join(process.cwd(), 'storage');
    if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
  }

  async upload(filePath: string, remoteName: string): Promise<UploadResult> {
    const dest = path.join(this.basePath, remoteName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);
    return { fileId: remoteName };
  }

  async download(fileId: string, destPath: string): Promise<void> {
    fs.copyFileSync(path.join(this.basePath, fileId), destPath);
  }

  async delete(fileId: string): Promise<void> {
    const p = path.join(this.basePath, fileId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async testConnection(): Promise<boolean> {
    return fs.existsSync(this.basePath);
  }
}

// ──── S3 Adapter ────────────────────────────────────────────────────────────
export class S3Adapter implements StorageAdapter {
  private config: Record<string, string>;
  private bucketName: string;

  constructor(config: Record<string, string>, bucketName: string) {
    this.config = config;
    this.bucketName = bucketName;
  }

  async upload(filePath: string, remoteName: string): Promise<UploadResult> {
    try {
      // Lazy-load S3 SDK to avoid requiring it if not configured
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3' as any);
      const client = new S3Client({
        region: this.config.region || 'us-east-1',
        endpoint: this.config.endpoint,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
        forcePathStyle: !!this.config.endpoint,
      });
      const fileStream = fs.createReadStream(filePath);
      await client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: remoteName,
        Body: fileStream,
      }));
      return { fileId: remoteName, url: `s3://${this.bucketName}/${remoteName}` };
    } catch (err: any) {
      throw new Error(`S3 upload failed: ${err.message}`);
    }
  }

  async download(fileId: string, destPath: string): Promise<void> {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3' as any);
    const client = new S3Client({
      region: this.config.region || 'us-east-1',
      endpoint: this.config.endpoint,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      forcePathStyle: !!this.config.endpoint,
    });
    const res = await client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: fileId }));
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      (res.Body as stream.Readable).pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async delete(fileId: string): Promise<void> {
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3' as any);
    const client = new S3Client({
      region: this.config.region || 'us-east-1',
      endpoint: this.config.endpoint,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      forcePathStyle: !!this.config.endpoint,
    });
    await client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: fileId }));
  }

  async testConnection(): Promise<boolean> {
    try {
      const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3' as any);
      const client = new S3Client({
        region: this.config.region || 'us-east-1',
        endpoint: this.config.endpoint,
        credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
        forcePathStyle: !!this.config.endpoint,
      });
      await client.send(new ListBucketsCommand({}));
      return true;
    } catch { return false; }
  }
}

// ──── Google Drive Adapter ───────────────────────────────────────────────────
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
    const rootFolderId = await this.getOrCreateFolder(drive, 'CAPS_PLATFORM_BACKUPS');
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

// ──── Storage Router ─────────────────────────────────────────────────────────
export function createAdapter(
  providerType: string,
  credentials: Record<string, string>,
  bucketName?: string,
  endpointUrl?: string
): StorageAdapter {
  switch (providerType) {
    case 'google_drive': return new GoogleDriveAdapter(credentials);
    case 's3': return new S3Adapter({ ...credentials, endpoint: endpointUrl || '' }, bucketName || 'caps-backups');
    case 'minio': return new S3Adapter({ ...credentials, endpoint: endpointUrl || 'http://minio:9000' }, bucketName || 'caps-backups');
    default: return new LocalAdapter();
  }
}
