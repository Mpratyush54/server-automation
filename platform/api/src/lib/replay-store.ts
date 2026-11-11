/**
 * Object storage for session replay chunks (#40).
 *
 * Bucket `replays` on the bundled MinIO (created by platformctl's telemetry storage
 * step, with a lifecycle rule on the `replays/` prefix), written by the API's
 * bucket-scoped storage user (MINIO_API_ACCESS_KEY / MINIO_API_SECRET_KEY).
 *
 * | Variable                 | Default                         |
 * |--------------------------|---------------------------------|
 * | REPLAYS_S3_ENDPOINT      | MINIO_ENDPOINT                  |
 * | REPLAYS_BUCKET           | `replays`                       |
 * | REPLAYS_S3_ACCESS_KEY    | MINIO_API_ACCESS_KEY            |
 * | REPLAYS_S3_SECRET_KEY    | MINIO_API_SECRET_KEY            |
 * | REPLAYS_S3_REGION        | `us-east-1`                     |
 *
 * Object layout: `replays/<projectId>/<sessionId>/<seq>.json.gz` (gzip of the SDK's
 * chunk envelope, stored as uploaded). GDPR delete and retention remove the
 * `replays/<projectId>/<sessionId>/` prefix.
 */
export interface ReplayObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Delete every object under the prefix; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

export function replayChunkKey(projectId: string, sessionId: string, seq: number): string {
  return `${replaySessionPrefix(projectId, sessionId)}${seq}.json.gz`;
}

export function replaySessionPrefix(projectId: string, sessionId: string): string {
  return `replays/${projectId}/${sessionId}/`;
}

export function replayStoreConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    endpoint: env.REPLAYS_S3_ENDPOINT || env.MINIO_ENDPOINT || '',
    bucket: env.REPLAYS_BUCKET || 'replays',
    accessKeyId: env.REPLAYS_S3_ACCESS_KEY || env.MINIO_API_ACCESS_KEY || env.MINIO_ACCESS_KEY || '',
    secretAccessKey: env.REPLAYS_S3_SECRET_KEY || env.MINIO_API_SECRET_KEY || env.MINIO_SECRET_KEY || '',
    region: env.REPLAYS_S3_REGION || 'us-east-1',
  };
}

class S3ReplayStore implements ReplayObjectStore {
  private client: any;
  private sdk: any;
  constructor(private readonly cfg: ReturnType<typeof replayStoreConfig>) {}

  private s3() {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.sdk = require('@aws-sdk/client-s3');
      this.client = new this.sdk.S3Client({
        endpoint: this.cfg.endpoint,
        region: this.cfg.region,
        forcePathStyle: true,
        credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
      });
    }
    return this.client;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const c = this.s3();
    await c.send(new this.sdk.PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    const c = this.s3();
    try {
      const out = await c.send(new this.sdk.GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      const bytes = await out.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const c = this.s3();
    let count = 0;
    let token: string | undefined;
    do {
      const listed = await c.send(new this.sdk.ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (listed.Contents || []).map((o: { Key?: string }) => o.Key).filter(Boolean) as string[];
      if (keys.length) {
        await c.send(new this.sdk.DeleteObjectsCommand({
          Bucket: this.cfg.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }));
        count += keys.length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return count;
  }
}

let override: ReplayObjectStore | null | undefined;
let cached: ReplayObjectStore | null = null;

/** The configured replay store, or null when object storage is not configured. */
export function getReplayStore(env: NodeJS.ProcessEnv = process.env): ReplayObjectStore | null {
  if (override !== undefined) return override;
  if (cached) return cached;
  const cfg = replayStoreConfig(env);
  if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) return null;
  cached = new S3ReplayStore(cfg);
  return cached;
}

/** Tests: replace the store (null = not configured; undefined = back to env). */
export function setReplayStoreForTests(store: ReplayObjectStore | null | undefined): void {
  override = store;
  cached = null;
}
