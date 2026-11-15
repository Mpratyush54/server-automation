/** Installer-managed S3 settings. Credentials arrive from the Kubernetes Secret. */
export function objectStorageConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.OBJECT_STORAGE_MODE !== 'external') return null;
  if (!env.OBJECT_STORAGE_ENDPOINT || !env.OBJECT_STORAGE_ACCESS_KEY || !env.OBJECT_STORAGE_SECRET_KEY) {
    throw new Error('External object storage requires an endpoint and credentials from platform-object-storage');
  }
  return {
    endpoint: env.OBJECT_STORAGE_ENDPOINT || '',
    region: env.OBJECT_STORAGE_REGION || 'us-east-1',
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY || '',
    secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY || '',
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false',
    bucket: (purpose: string) => `${env.OBJECT_STORAGE_BUCKET_PREFIX || 'cairn'}-${purpose}`,
  };
}
