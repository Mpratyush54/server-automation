import { objectStorageConfig } from '../../../src/lib/object-storage-config';
import { replayStoreConfig } from '../../../src/lib/replay-store';
import { uploadStoreFromEnv, S3UploadStore } from '../../../src/lib/upload-store';
import { createDefaultBackupAdapter, defaultBackupProviderType } from '../../../src/lib/storage-service';
import { ensureBundledStorage, BUNDLED_STORAGE_ID } from '../../../src/lib/storage-providers';

const env = {
  OBJECT_STORAGE_MODE: 'external', OBJECT_STORAGE_ENDPOINT: 'https://objects.example.com',
  OBJECT_STORAGE_REGION: 'eu-west-1', OBJECT_STORAGE_BUCKET_PREFIX: 'team-cairn',
  OBJECT_STORAGE_ACCESS_KEY: 'example-access', OBJECT_STORAGE_SECRET_KEY: 'example-secret',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
};

it('selects external settings only in external mode', () => {
  expect(objectStorageConfig({})).toBeNull();
  expect(objectStorageConfig({ ...env, OBJECT_STORAGE_MODE: 'bundled' })).toBeNull();
  expect(objectStorageConfig(env)).toMatchObject({ region: 'eu-west-1', forcePathStyle: false });
  expect(objectStorageConfig(env)!.bucket('uploads')).toBe('team-cairn-uploads');
  expect(() => objectStorageConfig({ OBJECT_STORAGE_MODE: 'external' })).toThrow('platform-object-storage');
});

it('uses external upload settings for both S3 operations and presigned URLs', () => {
  const store = uploadStoreFromEnv(env) as S3UploadStore;
  expect(store).toBeInstanceOf(S3UploadStore);
  expect((store as any).cfg).toMatchObject({ endpoint: env.OBJECT_STORAGE_ENDPOINT, region: 'eu-west-1',
    accessKeyId: 'example-access', secretAccessKey: 'example-secret', bucket: 'team-cairn-uploads',
    forcePathStyle: false, ensureBucket: false });
  const url = new URL(store.presign('PUT', 'file.txt')!);
  expect(url.host).toBe('team-cairn-uploads.objects.example.com');
  expect(url.pathname).toBe('/file.txt');
  expect(url.searchParams.get('X-Amz-Credential')).toContain('/eu-west-1/s3/aws4_request');
  const pathStore = uploadStoreFromEnv({ ...env, OBJECT_STORAGE_FORCE_PATH_STYLE: 'true' });
  expect(new URL(pathStore.presign('GET', 'file.txt')!).pathname).toBe('/team-cairn-uploads/file.txt');
});

it('routes replays and API backups to external buckets with matching addressing', () => {
  expect(replayStoreConfig(env)).toEqual({ endpoint: env.OBJECT_STORAGE_ENDPOINT, bucket: 'team-cairn-replays',
    accessKeyId: 'example-access', secretAccessKey: 'example-secret', region: 'eu-west-1', forcePathStyle: false });
  expect(defaultBackupProviderType(env)).toBe('s3');
  const adapter = createDefaultBackupAdapter(env) as any;
  expect(adapter.bucketName).toBe('team-cairn-backups');
  expect(adapter.config).toMatchObject({ endpoint: env.OBJECT_STORAGE_ENDPOINT, region: 'eu-west-1', forcePathStyle: 'false' });
  expect((createDefaultBackupAdapter({ ...env, BACKUP_S3_ENDPOINT: 'https://backups.example.com' }) as any).config.endpoint).toBe('https://backups.example.com');
});

it('registers external S3 as default and preserves an operator-selected default', async () => {
  const rows = new Map<string, any>();
  const repo = { create: (p: any) => p, save: async (p: any) => rows.set(p.id, p),
    findOneBy: async (q: any) => [...rows.values()].find(r => Object.entries(q).every(([k, v]) => r[k] === v)) || null };
  const ds: any = { transaction: async (fn: any) => fn({ query: jest.fn(), getRepository: () => repo }) };
  await ensureBundledStorage(ds, env);
  expect(rows.get(BUNDLED_STORAGE_ID)).toMatchObject({ providerType: 's3', isDefault: true,
    bucketName: 'team-cairn-uploads', endpointUrl: env.OBJECT_STORAGE_ENDPOINT,
    credentials: { region: 'eu-west-1', forcePathStyle: 'false' } });
  rows.get(BUNDLED_STORAGE_ID).isDefault = false;
  rows.set('custom', { id: 'custom', isDefault: true });
  await ensureBundledStorage(ds, env);
  expect(rows.get(BUNDLED_STORAGE_ID).isDefault).toBe(false);
});
