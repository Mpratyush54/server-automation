import { getDb } from '../config/database';
import { StorageProvider } from '../entities/StorageProvider';
import { File, FileProvider } from '../entities/File';
import { getUploadStore, LocalUploadStore, S3UploadStore, UploadStore } from './upload-store';
import { objectStorageConfig } from './object-storage-config';
import { BUNDLED_STORAGE_ID } from './storage-providers';

/**
 * Browser-reachable endpoint for presigned uploads. Only the installer-managed
 * provider has one, matching uploadStoreFromEnv: UPLOADS_S3_PUBLIC_ENDPOINT, or
 * the external object storage endpoint (#176). Other providers stream through the API.
 */
export function providerPublicEndpoint(p: StorageProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (p.id !== BUNDLED_STORAGE_ID) return undefined;
  if (env.UPLOADS_S3_PUBLIC_ENDPOINT) return env.UPLOADS_S3_PUBLIC_ENDPOINT;
  try {
    return objectStorageConfig(env)?.endpoint || undefined;
  } catch {
    return undefined;
  }
}

export function providerUploadStore(p: StorageProvider): UploadStore {
  if (p.providerType === 'local') return new LocalUploadStore();
  if (!['s3', 'minio'].includes(p.providerType)) throw new Error('This provider does not support SDK uploads');
  const c = p.credentials || {};
  return new S3UploadStore({ endpoint: p.endpointUrl || '', bucket: p.bucketName!,
    accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region,
    forcePathStyle: c.forcePathStyle ? c.forcePathStyle === 'true' : !!p.endpointUrl,
    publicEndpoint: providerPublicEndpoint(p) });
}
export async function defaultUploadTarget(): Promise<{ store: UploadStore; providerId: string | null; providerType?: string }> {
  const p = await (await getDb()).getRepository(StorageProvider).findOne({ where: { isDefault: true } });
  return p && ['s3', 'minio', 'local'].includes(p.providerType) ? { store: providerUploadStore(p), providerId: p.id, providerType: p.providerType } : { store: getUploadStore(), providerId: null };
}
export async function fileUploadStore(file: File): Promise<UploadStore> {
  if (file.storageProviderId) {
    const p = await (await getDb()).getRepository(StorageProvider).findOne({ where: { id: file.storageProviderId } });
    if (!p) throw new Error('Original storage provider is unavailable');
    return providerUploadStore(p);
  }
  if (file.provider === FileProvider.LOCAL) return new LocalUploadStore();
  // Existing files without a provider id retain the environment target.
  return getUploadStore();
}
