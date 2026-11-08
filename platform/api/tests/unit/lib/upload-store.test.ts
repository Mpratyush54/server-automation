import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { presignS3Url } from '../../../src/lib/s3-presign';
import { LocalUploadStore, S3UploadStore, UploadStore, uploadStoreFromEnv } from '../../../src/lib/upload-store';
import { createDefaultBackupAdapter, defaultBackupProviderType, LocalAdapter, S3Adapter } from '../../../src/lib/storage-service';

describe('presignS3Url (SigV4 query auth)', () => {
  it('matches the AWS documentation example signature', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignS3Url({
      method: 'GET',
      endpoint: 'https://s3.amazonaws.com',
      pathStyle: false,
      bucket: 'examplebucket',
      key: 'test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      expiresSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('builds path-style URLs for MinIO and keeps key slashes', () => {
    const url = presignS3Url({
      method: 'PUT',
      endpoint: 'https://s3.example.test:9443',
      bucket: 'platform-uploads',
      key: 'proj/file id',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    });
    expect(url.startsWith('https://s3.example.test:9443/platform-uploads/proj/file%20id?')).toBe(true);
    expect(url).toContain('X-Amz-Expires=900');
  });
});

/** Minimal in-memory S3 emulating the commands S3UploadStore sends. */
function fakeS3() {
  const buckets = new Map<string, Map<string, Buffer>>();
  class Cmd {
    constructor(public input: any) {}
  }
  const cmd: any = {};
  for (const n of ['HeadBucketCommand', 'CreateBucketCommand', 'PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']) {
    cmd[n] = class extends Cmd {
      name = n;
    };
  }
  const notFound = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  const client = {
    sent: [] as string[],
    async send(c: any) {
      client.sent.push(c.name);
      const { Bucket, Key } = c.input;
      switch (c.name) {
        case 'HeadBucketCommand':
          if (!buckets.has(Bucket)) throw notFound('NotFound');
          return {};
        case 'CreateBucketCommand':
          buckets.set(Bucket, new Map());
          return {};
        case 'PutObjectCommand': {
          const chunks: Buffer[] = [];
          for await (const ch of c.input.Body as Readable) chunks.push(Buffer.from(ch));
          buckets.get(Bucket)!.set(Key, Buffer.concat(chunks));
          return {};
        }
        case 'GetObjectCommand': {
          const obj = buckets.get(Bucket)?.get(Key);
          if (!obj) throw notFound('NoSuchKey');
          return { Body: Readable.from([obj]) };
        }
        case 'DeleteObjectCommand':
          buckets.get(Bucket)?.delete(Key);
          return {};
      }
      throw new Error(`unexpected ${c.name}`);
    },
  };
  return { client, cmd, buckets };
}

async function readAll(r: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of r as any) chunks.push(Buffer.from(ch));
  return Buffer.concat(chunks).toString('utf8');
}

function tmpFile(content: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upl-')), 'f');
  fs.writeFileSync(p, content);
  return p;
}

/** The contract every UploadStore must satisfy. */
function contract(name: string, make: () => UploadStore) {
  describe(`${name} upload store contract`, () => {
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    it('put → get → delete → get null', async () => {
      const store = make();
      await store.put(key, tmpFile('hello object'), 'text/plain');
      const body = await store.get(key);
      expect(body).not.toBeNull();
      expect(await readAll(body!)).toBe('hello object');
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
    });
    it('get of a missing key is null, delete of a missing key is a no-op', async () => {
      const store = make();
      const missing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      expect(await store.get(missing)).toBeNull();
      await expect(store.delete(missing)).resolves.toBeUndefined();
    });
  });
}

contract('local', () => new LocalUploadStore());
const s3 = fakeS3();
contract('s3 (fake)', () => new S3UploadStore({ endpoint: 'http://minio:9000', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'platform-uploads', ensureBucket: true }, s3));

// Real MinIO: MINIO_TEST_ENDPOINT=http://localhost:9000 MINIO_TEST_ACCESS_KEY=... MINIO_TEST_SECRET_KEY=... npm test
const minio = process.env.MINIO_TEST_ENDPOINT;
(minio ? contract : (n: string) => describe.skip(`${n} upload store contract (set MINIO_TEST_ENDPOINT)`, () => { it('skipped', () => {}); }))(
  'minio (live container)',
  () => new S3UploadStore({
    endpoint: minio || '',
    accessKeyId: process.env.MINIO_TEST_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.MINIO_TEST_SECRET_KEY || 'minioadmin',
    bucket: 'platform-uploads-test',
    ensureBucket: true,
  }),
);

describe('S3UploadStore', () => {
  it('creates the bundled bucket once when missing', async () => {
    const f = fakeS3();
    const store = new S3UploadStore({ endpoint: 'http://minio:9000', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'platform-uploads', ensureBucket: true }, f);
    await store.put('p/x', tmpFile('1'));
    await store.put('p/y', tmpFile('2'));
    expect(f.client.sent.filter((n) => n === 'CreateBucketCommand')).toHaveLength(1);
    expect(f.buckets.get('platform-uploads')!.size).toBe(2);
  });

  it('presigns only with a public endpoint', () => {
    const base = { endpoint: 'http://minio.storage:9000', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'platform-uploads' };
    expect(new S3UploadStore(base).presign('PUT', 'p/x')).toBeNull();
    const url = new S3UploadStore({ ...base, publicEndpoint: 'https://s3.example.test' }).presign('GET', 'p/x', 60);
    expect(url).toMatch(/^https:\/\/s3\.example\.test\/platform-uploads\/p\/x\?.*X-Amz-Expires=60/);
  });
});

describe('uploadStoreFromEnv', () => {
  it('defaults to the bundled MinIO bucket platform-uploads when MINIO_ENDPOINT is set', () => {
    const store = uploadStoreFromEnv({ MINIO_ENDPOINT: 'http://minio.storage:9000', MINIO_ACCESS_KEY: 'a', MINIO_SECRET_KEY: 'b' } as any);
    expect(store.kind).toBe('s3');
    expect(store.bucket).toBe('platform-uploads');
  });
  it('uses a configured S3 target over MinIO', () => {
    const store = uploadStoreFromEnv({ MINIO_ENDPOINT: 'http://m', UPLOADS_S3_ENDPOINT: 'https://s3.example', UPLOADS_BUCKET: 'mine' } as any);
    expect(store.kind).toBe('s3');
    expect(store.bucket).toBe('mine');
  });
  it('is local only without an object store (dev) or when forced', () => {
    expect(uploadStoreFromEnv({} as any).kind).toBe('local');
    expect(uploadStoreFromEnv({ MINIO_ENDPOINT: 'http://m', STORAGE_UPLOADS_BACKEND: 'local' } as any).kind).toBe('local');
  });
});

describe('default backup target', () => {
  it('is the bundled MinIO platform-backups bucket when MINIO_ENDPOINT is set', () => {
    const env = { MINIO_ENDPOINT: 'http://minio.storage:9000', MINIO_ACCESS_KEY: 'a', MINIO_SECRET_KEY: 'b' } as any;
    expect(defaultBackupProviderType(env)).toBe('minio');
    const adapter = createDefaultBackupAdapter(env) as any;
    expect(adapter).toBeInstanceOf(S3Adapter);
    expect(adapter.bucketName).toBe('platform-backups');
    expect(adapter.config.endpoint).toBe('http://minio.storage:9000');
  });
  it('honours a configurable S3 target', () => {
    const env = { MINIO_ENDPOINT: 'http://m', BACKUP_S3_ENDPOINT: 'https://s3.example', BACKUP_S3_ACCESS_KEY: 'k', BACKUP_BUCKET: 'offsite' } as any;
    expect(defaultBackupProviderType(env)).toBe('s3');
    const adapter = createDefaultBackupAdapter(env) as any;
    expect(adapter.bucketName).toBe('offsite');
    expect(adapter.config.accessKeyId).toBe('k');
  });
  it('falls back to the local adapter only without an object store', () => {
    expect(defaultBackupProviderType({} as any)).toBe('local');
    expect(createDefaultBackupAdapter({} as any)).toBeInstanceOf(LocalAdapter);
  });
});
