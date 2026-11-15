import { objectStorageConfig } from './object-storage-config';
import { DataSource, EntityManager } from 'typeorm';
import { getDb } from '../config/database';
import { StorageProvider, StorageProviderType } from '../entities/StorageProvider';
import { createAdapter } from './storage-service';
import { registerLeaderJob } from './scheduler';

export const BUNDLED_STORAGE_ID = '00000000-0000-4000-8000-000000000036';
export async function withStorageLock<T>(ds: DataSource, fn: (em: EntityManager) => Promise<T>): Promise<T> {
  return ds.transaction(async em => {
    await em.query(`SELECT pg_advisory_xact_lock(360036)`);
    return fn(em);
  });
}
export async function ensureBundledStorage(ds: DataSource, env = process.env): Promise<void> {
  const object = objectStorageConfig(env);
  const endpoint = object?.endpoint || env.MINIO_ENDPOINT;
  const accessKeyId = object?.accessKeyId || env.MINIO_API_ACCESS_KEY;
  const secretAccessKey = object?.secretAccessKey || env.MINIO_API_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return;
  await withStorageLock(ds, async em => {
    const repo = em.getRepository(StorageProvider);
    const existing = await repo.findOneBy({ id: BUNDLED_STORAGE_ID });
    const currentDefault = await repo.findOneBy({ isDefault: true });
    const provider = repo.create({
      ...(existing || {}), id: BUNDLED_STORAGE_ID, name: object ? 'Platform object storage' : 'Bundled MinIO', providerType: object ? StorageProviderType.S3 : StorageProviderType.MINIO,
      bucketName: env.UPLOADS_BUCKET || object?.bucket('uploads') || 'platform-uploads', endpointUrl: endpoint,
      credentials: { accessKeyId, secretAccessKey, region: object?.region || 'us-east-1', forcePathStyle: String(object?.forcePathStyle ?? true) },
      isDefault: !currentDefault || currentDefault.id === BUNDLED_STORAGE_ID,
    });
    await repo.save(provider);
  });
}
export async function checkStorageProvider(provider: StorageProvider): Promise<{ success: boolean; message: string }> {
  let message = 'Connection successful';
  let success = false;
  try {
    success = await createAdapter(provider.providerType, provider.credentials || {}, provider.bucketName || undefined, provider.endpointUrl || undefined).testConnection();
    if (!success) message = 'Connection failed';
  } catch (err: any) { message = err.message; }
  if (!['s3', 'minio'].includes(provider.providerType) && !success) message = 'Connection failed';
  await (await getDb()).getRepository(StorageProvider).update(provider.id, {
    healthStatus: success ? 'healthy' : 'unhealthy', lastError: success ? null : message, checkedAt: new Date(),
  });
  return { success, message };
}
export function startStorageHealth(): void {
  registerLeaderJob({ name: 'storage-health', intervalMs: 300000, initialDelayMs: 1000, run: async () => {
    const ds = await getDb();
    await ensureBundledStorage(ds);
    for (const provider of await ds.getRepository(StorageProvider).find()) await checkStorageProvider(provider);
  } });
}

/** Encrypt pre-upgrade plaintext provider JSON without a schema rewrite. */
export async function encryptLegacyStorage(ds: DataSource): Promise<void> {
  await withStorageLock(ds, async em => {
    const rows = await em.query(`SELECT id, credentials FROM storage_providers WHERE credentials IS NOT NULL AND NOT (credentials ? '__encrypted')`);
    for (const row of rows) await em.getRepository(StorageProvider).update(row.id, { credentials: row.credentials });
  });
}
