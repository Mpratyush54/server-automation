import { storagePreset } from '../../src/lib/storage-presets';
import { storageCredentialsTransformer as credentials, publicStorageProvider } from '../../src/lib/storage-credentials';
import { S3Adapter, storageConnectionError } from '../../src/lib/storage-service';
import { encryptLegacyStorage, ensureBundledStorage, BUNDLED_STORAGE_ID } from '../../src/lib/storage-providers';

const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: any) {} }
  return { S3Client: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
    PutObjectCommand: class Put extends Command {}, GetObjectCommand: class Get extends Command {}, DeleteObjectCommand: class Delete extends Command {} };
});
const input = { bucketName: 'example-bucket', credentials: { accessKeyId: 'key', secretAccessKey: 'secret' } };
beforeEach(() => { mockSend.mockReset(); mockDestroy.mockReset(); });
it('derives R2 with only account id, key, secret and bucket', () => {
  const p = storagePreset({ ...input, preset: 'r2', accountId: 'a'.repeat(32) });
  expect(p.endpointUrl).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
  expect(p.credentials.region).toBe('auto');
  expect(() => storagePreset({ ...input, preset: 'r2', accountId: 'invalid' })).toThrow('account ID');
});
it('maps AWS, GCS, B2 and generic presets and addressing', () => {
  expect(storagePreset({ ...input, preset: 'aws' })).toMatchObject({ endpointUrl: null, credentials: { forcePathStyle: 'false' } });
  expect(storagePreset({ ...input, preset: 'gcs' }).endpointUrl).toBe('https://storage.googleapis.com');
  expect(storagePreset({ ...input, preset: 'b2', credentials: { ...input.credentials, region: 'us-west-004' } }).endpointUrl).toBe('https://s3.us-west-004.backblazeb2.com');
  expect(storagePreset({ ...input, preset: 's3', endpointUrl: 'https://objects.example.com' }).endpointUrl).toBe('https://objects.example.com');
  expect(() => storagePreset({ ...input, preset: 's3', endpointUrl: 'https://user:secret@example.com' })).toThrow('Invalid storage endpoint');
});
it('encrypts at rest, reads legacy rows and omits every credential from responses', () => {
  process.env.SECRETS_ENCRYPTION_KEY = 'unit-test-only-key';
  const value = credentials.to(input.credentials)!;
  expect(JSON.stringify(value)).not.toContain('secret');
  expect(credentials.from(value)).toEqual(input.credentials);
  expect(credentials.from(input.credentials)).toEqual(input.credentials);
  expect(publicStorageProvider({ name: 'test', credentials: input.credentials })).toEqual({ name: 'test' });
});
it.each([
  ['NoSuchBucket', 'Bucket not found'], ['InvalidAccessKeyId', 'Authentication failed'],
  ['SignatureDoesNotMatch', 'Authentication failed'], ['AccessDenied', 'Access denied'],
  ['TimeoutError', 'timed out'], ['PermanentRedirect', 'Wrong endpoint'],
])('maps %s without exposing service messages', (name, message) => {
  expect(storageConnectionError({ name, message: 'sensitive-data' })).toContain(message);
  expect(storageConnectionError({ name, message: 'sensitive-data' })).not.toContain('sensitive-data');
});
it('probes put/get/delete on the configured bucket and verifies contents', async () => {
  let body = '';
  mockSend.mockImplementation(async cmd => {
    if (cmd.constructor.name === 'Put') body = cmd.input.Body;
    return cmd.constructor.name === 'Get' ? { Body: { transformToString: async () => body } } : {};
  });
  await expect(new S3Adapter(input.credentials, input.bucketName).testConnection()).resolves.toBe(true);
  expect(mockSend.mock.calls.map(c => c[0].constructor.name)).toEqual(['Put', 'Get', 'Delete']);
  for (const call of mockSend.mock.calls) expect(call[0].input.Bucket).toBe('example-bucket');
  expect(mockDestroy).toHaveBeenCalled();
});
it.each(['Put', 'Get', 'Delete'])('reports %s failure and attempts cleanup', async stage => {
  let body = '';
  mockSend.mockImplementation(async cmd => {
    if (cmd.constructor.name === stage) throw { name: 'AccessDenied', message: 'do not expose' };
    if (cmd.constructor.name === 'Put') body = cmd.input.Body;
    return cmd.constructor.name === 'Get' ? { Body: { transformToString: async () => body } } : {};
  });
  await expect(new S3Adapter(input.credentials, input.bucketName).testConnection()).rejects.toThrow(`${stage.toLowerCase()}: Access denied`);
  expect(mockSend.mock.calls[mockSend.mock.calls.length - 1][0].constructor.name).toBe('Delete');
});
it('boot registration is idempotent and preserves an operator default', async () => {
  const rows = new Map<string, any>();
  const repo = { create: (p: any) => p, save: async (p: any) => rows.set(p.id, p), findOneBy: async (q: any) => [...rows.values()].find(r => Object.entries(q).every(([k,v]) => r[k] === v)) || null };
  const query = jest.fn();
  const ds: any = { transaction: async (fn: any) => fn({ query, getRepository: () => repo }) };
  const env = { MINIO_ENDPOINT: 'http://minio:9000', MINIO_API_ACCESS_KEY: 'api', MINIO_API_SECRET_KEY: 'secret' };
  await ensureBundledStorage(ds, env); await ensureBundledStorage(ds, env);
  expect(rows.size).toBe(1); expect(rows.get(BUNDLED_STORAGE_ID).isDefault).toBe(true);
  rows.get(BUNDLED_STORAGE_ID).isDefault = false;
  rows.set('external', { id: 'external', isDefault: true });
  await ensureBundledStorage(ds, env);
  expect(rows.get(BUNDLED_STORAGE_ID).isDefault).toBe(false);
  expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(360036)');
});

it('encrypts legacy credentials through the entity transformer on startup', async () => {
  const update = jest.fn();
  const ds: any = { transaction: async (fn: any) => fn({
    query: jest.fn().mockImplementation(async (sql: string) => sql.includes('SELECT id') ? [{ id: 'legacy', credentials: input.credentials }] : []),
    getRepository: () => ({ update }),
  }) };
  await encryptLegacyStorage(ds);
  expect(update).toHaveBeenCalledWith('legacy', { credentials: input.credentials });
});
it('does not register bundled storage when scoped credentials are absent', async () => {
  const ds: any = { transaction: jest.fn() };
  await ensureBundledStorage(ds, { MINIO_ENDPOINT: 'http://minio:9000' });
  expect(ds.transaction).not.toHaveBeenCalled();
});
