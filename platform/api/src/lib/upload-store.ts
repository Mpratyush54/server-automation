import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { presignS3Url } from './s3-presign';

/**
 * Object storage for SDK/portal file uploads.
 *
 * Default in the cluster: the bundled MinIO, bucket `platform-uploads`
 * (or any S3-compatible target via UPLOADS_S3_*). The local directory store
 * exists only for development — it pins files to one pod's disk.
 */
export interface UploadStore {
  readonly kind: 's3' | 'local';
  readonly bucket: string;
  put(key: string, filePath: string, contentType?: string | null): Promise<void>;
  /** Readable for the object, or null when it does not exist. */
  get(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
  /** Presigned URL clients can use directly, or null when not configured. */
  presign(method: 'GET' | 'PUT', key: string, expiresSeconds?: number): string | null;
}

export const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
export const DEFAULT_UPLOADS_BUCKET = 'platform-uploads';

/** Resolve `name` inside UPLOADS_DIR; returns null if the result would escape the directory. */
export function containedUploadPath(name: string): string | null {
  const resolved = path.resolve(UPLOADS_DIR, name);
  if (path.dirname(resolved) !== UPLOADS_DIR) return null;
  return resolved;
}

/**
 * Development store: one flat directory. Keys like `${projectId}/${fileId}`
 * map to the last segment (the server-generated UUID), as older versions did.
 */
export class LocalUploadStore implements UploadStore {
  readonly kind = 'local' as const;
  readonly bucket = 'local';

  private pathFor(key: string): string {
    const name = key.split('/').pop() || '';
    const p = containedUploadPath(name);
    if (!p) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, filePath: string): Promise<void> {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const dest = this.pathFor(key);
    try {
      fs.renameSync(filePath, dest);
    } catch {
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
    }
  }

  async get(key: string): Promise<Readable | null> {
    const p = this.pathFor(key);
    return fs.existsSync(p) ? fs.createReadStream(p) : null;
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  presign(): string | null {
    return null;
  }
}

export interface S3UploadStoreConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
  /** Externally reachable S3 endpoint for presigned URLs (unset = no presigning). */
  publicEndpoint?: string;
  /** Create the bucket on first use when missing (bundled MinIO). */
  ensureBucket?: boolean;
  forcePathStyle?: boolean;
}

/** Minimal S3 client surface (an @aws-sdk/client-s3 S3Client); injectable for tests. */
export interface S3Like {
  send(command: any): Promise<any>;
}

function isNotFound(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  return status === 404 || err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.Code === 'NoSuchKey';
}

export class S3UploadStore implements UploadStore {
  readonly kind = 's3' as const;
  readonly bucket: string;
  private clientPromise: Promise<{ client: S3Like; cmd: any }> | null = null;
  private bucketReady: Promise<void> | null = null;

  constructor(
    private readonly cfg: S3UploadStoreConfig,
    private readonly injected?: { client: S3Like; cmd: any },
  ) {
    this.bucket = cfg.bucket;
  }

  private async sdk(): Promise<{ client: S3Like; cmd: any }> {
    if (this.injected) return this.injected;
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const cmd: any = await import('@aws-sdk/client-s3');
        const client = new cmd.S3Client({
          region: this.cfg.region || 'us-east-1',
          endpoint: this.cfg.endpoint || undefined,
          credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
          forcePathStyle: this.cfg.forcePathStyle ?? true,
        });
        return { client, cmd };
      })();
    }
    return this.clientPromise;
  }

  private async ready(): Promise<{ client: S3Like; cmd: any }> {
    const s = await this.sdk();
    if (this.cfg.ensureBucket) {
      if (!this.bucketReady) {
        this.bucketReady = (async () => {
          try {
            await s.client.send(new s.cmd.HeadBucketCommand({ Bucket: this.bucket }));
          } catch (err: any) {
            if (!isNotFound(err)) throw err;
            try {
              await s.client.send(new s.cmd.CreateBucketCommand({ Bucket: this.bucket }));
            } catch (createErr: any) {
              if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(createErr?.name || '')) throw createErr;
            }
          }
        })().catch((err) => {
          this.bucketReady = null; // retry on the next call
          throw err;
        });
      }
      await this.bucketReady;
    }
    return s;
  }

  async put(key: string, filePath: string, contentType?: string | null): Promise<void> {
    const { client, cmd } = await this.ready();
    const size = fs.statSync(filePath).size;
    try {
      await client.send(new cmd.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType || 'application/octet-stream',
      }));
    } finally {
      fs.unlink(filePath, () => {});
    }
  }

  async get(key: string): Promise<Readable | null> {
    const { client, cmd } = await this.ready();
    try {
      const res = await client.send(new cmd.GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (res?.Body as Readable) || null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { client, cmd } = await this.ready();
    await client.send(new cmd.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  presign(method: 'GET' | 'PUT', key: string, expiresSeconds = 900): string | null {
    if (!this.cfg.publicEndpoint) return null;
    return presignS3Url({
      method,
      endpoint: this.cfg.publicEndpoint,
      bucket: this.bucket,
      key,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      expiresSeconds,
    });
  }
}

/**
 * Pick the upload store from the environment:
 *  - STORAGE_UPLOADS_BACKEND=local|s3 forces one;
 *  - otherwise S3 when an endpoint is configured (UPLOADS_S3_ENDPOINT, or the
 *    bundled MINIO_ENDPOINT that platformctl sets), else local (dev only).
 */
export function uploadStoreFromEnv(env: NodeJS.ProcessEnv = process.env): UploadStore {
  const backend = (env.STORAGE_UPLOADS_BACKEND || '').toLowerCase();
  const endpoint = env.UPLOADS_S3_ENDPOINT || env.MINIO_ENDPOINT || '';
  if (backend === 'local' || (!backend && !endpoint)) {
    if (env.NODE_ENV === 'production') {
      console.warn('[storage] using the local uploads directory — files live on one pod; configure MinIO/S3');
    }
    return new LocalUploadStore();
  }
  if (!endpoint) throw new Error('STORAGE_UPLOADS_BACKEND=s3 requires UPLOADS_S3_ENDPOINT or MINIO_ENDPOINT');
  const bundled = !env.UPLOADS_S3_ENDPOINT;
  return new S3UploadStore({
    endpoint,
    accessKeyId: env.UPLOADS_S3_ACCESS_KEY || env.MINIO_API_ACCESS_KEY || env.MINIO_ACCESS_KEY || '',
    secretAccessKey: env.UPLOADS_S3_SECRET_KEY || env.MINIO_API_SECRET_KEY || env.MINIO_SECRET_KEY || '',
    bucket: env.UPLOADS_BUCKET || DEFAULT_UPLOADS_BUCKET,
    region: env.UPLOADS_S3_REGION || 'us-east-1',
    publicEndpoint: env.UPLOADS_S3_PUBLIC_ENDPOINT || undefined,
    ensureBucket: (bundled && !env.MINIO_API_ACCESS_KEY) || env.UPLOADS_S3_CREATE_BUCKET === 'true',
  });
}

let store: UploadStore | null = null;

export function getUploadStore(): UploadStore {
  if (!store) store = uploadStoreFromEnv();
  return store;
}

/** Test hook. */
export function setUploadStoreForTests(s: UploadStore | null): void {
  store = s;
}
