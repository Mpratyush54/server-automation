export const STORAGE_PRESETS = ['aws', 'r2', 'gcs', 'b2', 's3', 'minio'] as const;

/** Only server-derived fields and supported credentials reach the provider row. */
export function storagePreset(input: any): any {
  const preset = input.preset || input.providerType || 's3';
  const c = input.credentials || {};
  if (preset === 'local') return { name: String(input.name || 'Local storage').slice(0, 100), providerType: 'local', isDefault: input.isDefault === true, credentials: {} };
  if (preset === 'google_drive') {
    if (input.isDefault) throw new Error('Google Drive is supported for backups only');
    if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new Error('Google Drive OAuth credentials are required');
    return { name: String(input.name || 'Google Drive').slice(0, 100), providerType: 'google_drive', isDefault: false,
      credentials: { clientId: String(c.clientId), clientSecret: String(c.clientSecret), refreshToken: String(c.refreshToken) } };
  }
  if (!STORAGE_PRESETS.includes(preset)) throw new Error('Unsupported storage preset');
  const region = preset === 'r2' ? 'auto' : (c.region || (preset === 'gcs' ? 'auto' : 'us-east-1'));
  let endpoint = input.endpointUrl || null;
  if (preset === 'r2') {
    if (!/^[a-f0-9]{32}$/i.test(input.accountId || '')) throw new Error('R2 account ID must contain 32 hexadecimal characters');
    endpoint = `https://${input.accountId}.r2.cloudflarestorage.com`;
  }
  if (preset === 'gcs') endpoint = 'https://storage.googleapis.com';
  if (preset === 'aws') endpoint = null;
  if (preset === 'b2') {
    if (!/^[a-z0-9-]+$/.test(c.region || '')) throw new Error('B2 region is required');
    endpoint = `https://s3.${c.region}.backblazeb2.com`;
  }
  if (endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid storage endpoint');
  } else if (preset === 's3' || preset === 'minio') throw new Error('Endpoint URL is required');
  if (!c.accessKeyId || !c.secretAccessKey || !input.bucketName) throw new Error('Access key, secret key and bucket are required');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucketName)) throw new Error('Invalid bucket name');
  return {
    name: String(input.name || preset.toUpperCase()).slice(0, 100),
    providerType: preset === 'minio' ? 'minio' : 's3', endpointUrl: endpoint,
    bucketName: input.bucketName, isDefault: input.isDefault === true,
    credentials: { accessKeyId: String(c.accessKeyId), secretAccessKey: String(c.secretAccessKey), region,
      forcePathStyle: preset === 'aws' ? 'false' : 'true' },
  };
}
