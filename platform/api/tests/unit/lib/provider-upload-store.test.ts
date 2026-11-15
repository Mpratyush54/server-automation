jest.mock('../../../src/config/database', () => ({ getDb: async () => { throw new Error('no database in this test'); } }));
jest.mock('../../../src/lib/scheduler', () => ({ registerLeaderJob: () => undefined }));
import { providerPublicEndpoint, providerUploadStore } from '../../../src/lib/provider-upload-store';
import { BUNDLED_STORAGE_ID } from '../../../src/lib/storage-providers';

const ENV_KEYS = ['OBJECT_STORAGE_MODE', 'OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY', 'UPLOADS_S3_PUBLIC_ENDPOINT'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const external = {
  OBJECT_STORAGE_MODE: 'external', OBJECT_STORAGE_ENDPOINT: 'https://s3.example.test',
  OBJECT_STORAGE_ACCESS_KEY: 'a', OBJECT_STORAGE_SECRET_KEY: 'b',
};
const platformProvider = (endpointUrl: string) => ({
  id: BUNDLED_STORAGE_ID, providerType: 's3', bucketName: 'cairn-uploads', endpointUrl,
  credentials: { accessKeyId: 'a', secretAccessKey: 'b', region: 'us-east-1', forcePathStyle: 'true' },
}) as any;

describe('presigned uploads through the default storage provider', () => {
  it('presigns against the external object storage endpoint (#176)', () => {
    Object.assign(process.env, external);
    const url = providerUploadStore(platformProvider('https://s3.example.test')).presign('PUT', 'p/f', 60);
    expect(url).toMatch(/^https:\/\/s3\.example\.test\/cairn-uploads\/p\/f\?.*X-Amz-Expires=60/);
  });

  it('prefers UPLOADS_S3_PUBLIC_ENDPOINT for the platform provider', () => {
    expect(providerPublicEndpoint(platformProvider('http://minio.storage:9000'), { UPLOADS_S3_PUBLIC_ENDPOINT: 'https://files.example.test' } as any))
      .toBe('https://files.example.test');
  });

  it('does not presign for the bundled MinIO or for user-added providers', () => {
    expect(providerUploadStore(platformProvider('http://minio.storage:9000')).presign('PUT', 'p/f')).toBeNull();
    Object.assign(process.env, external);
    expect(providerUploadStore({ ...platformProvider('https://s3.other.test'), id: 'user-provider' }).presign('PUT', 'p/f')).toBeNull();
  });

  it('does not throw when external credentials are missing', () => {
    expect(providerPublicEndpoint(platformProvider('https://s3.example.test'), { OBJECT_STORAGE_MODE: 'external', OBJECT_STORAGE_ENDPOINT: 'https://s3.example.test' } as any)).toBeUndefined();
  });
});
