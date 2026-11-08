import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
const mockRepos: any = {};
const mockUpload = jest.fn().mockResolvedValue({ fileId: 'persisted-dump' });
const mockDownload = jest.fn().mockResolvedValue(undefined);
const mockCreateAdapter = jest.fn((..._args: any[]) => ({ upload: mockUpload, download: mockDownload }));
const mockRestore = jest.fn((..._args: any[]) => Promise.resolve({ success: true }));
const mockChecksum = jest.fn((..._args: any[]) => Promise.resolve('checksum'));
jest.mock('../../src/config/database', () => ({ getDb: async () => ({ getRepository: (entity: any) => mockRepos[entity.name] }) }));
jest.mock('../../src/middleware/auth', () => ({ expressAuthenticate: (req: any, _res: any, next: any) => { req.user = { id: 'admin', role: 'admin' }; next(); }, expressRequireRole: () => (_req: any, _res: any, next: any) => next(), logAudit: jest.fn() }));
let mockDefaultType = 'local';
jest.mock('../../src/lib/storage-service', () => ({
  createAdapter: (...args: any[]) => mockCreateAdapter(...args),
  defaultBackupProviderType: () => mockDefaultType,
  createDefaultBackupAdapter: () => mockCreateAdapter('default', mockDefaultType),
}));
jest.mock('../../src/lib/database-service', () => ({ dumpDatabase: jest.fn().mockResolvedValue({ success: true, sizeBytes: 10 }), computeFileChecksum: (...args: any[]) => mockChecksum(...args), restoreDatabase: (...args: any[]) => mockRestore(...args) }));
jest.mock('../../src/lib/secret-rotate', () => ({ rotatePlatformSecrets: jest.fn() }));
jest.mock('../../src/lib/notify', () => ({ notifyUser: jest.fn() }));
import settings from '../../src/routes/settings';

const projectId = 'project-a';
const backup: any = { id: 'backup-a', projectId, dbName: 'project_db', environment: 'production', status: 'completed', fileId: 'dump', checksum: 'checksum', providerType: 's3', providerId: 'original-provider' };
const app = express(); app.use(express.json()); app.use(settings);
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
beforeEach(() => {
  jest.clearAllMocks();
  mockDefaultType = 'local';
  mockDownload.mockResolvedValue(undefined); mockChecksum.mockResolvedValue('checksum');
  mockRepos.Project = { findOne: jest.fn().mockResolvedValue({ id: projectId, name: 'project', databaseResources: { production: { dbName: 'project_db', username: 'project_user' } } }) };
  mockRepos.StorageProvider = { findOne: jest.fn(async ({ where }: any) => where.id ? { id: where.id, providerType: 's3', credentials: { region: 'original' } } : null) };
  mockRepos.DbBackup = { create: jest.fn((x: any) => ({ ...x, id: 'backup-a' })), save: jest.fn(async (x: any) => x), update: jest.fn(), findOne: jest.fn().mockResolvedValue({ ...backup }) };
  mockRepos.SmtpConfig = { findOne: jest.fn().mockResolvedValue(null) };
});
it('uploads a no-provider backup through the local adapter before marking it complete', async () => {
  const result = await request(app).post(`/projects/${projectId}/databases/backup`).send({ dbName: 'project_db', environment: 'production' });
  expect(result.status).toBe(202); await settle();
  expect(mockCreateAdapter).toHaveBeenCalledWith('default', 'local');
  expect(mockUpload).toHaveBeenCalled();
  expect(mockRepos.DbBackup.create).toHaveBeenCalledWith(expect.objectContaining({ providerId: null, providerType: 'local' }));
  expect(mockRepos.DbBackup.update).toHaveBeenCalledWith('backup-a', expect.objectContaining({ status: 'completed', fileId: 'persisted-dump' }));
});
it('sends a no-provider backup to the bundled MinIO target when one is configured', async () => {
  mockDefaultType = 'minio';
  expect((await request(app).post(`/projects/${projectId}/databases/backup`).send({ dbName: 'project_db' })).status).toBe(202);
  await settle();
  expect(mockRepos.DbBackup.create).toHaveBeenCalledWith(expect.objectContaining({ providerId: null, providerType: 'minio' }));
  expect(mockCreateAdapter).toHaveBeenCalledWith('default', 'minio');
  expect(mockRepos.DbBackup.update).toHaveBeenCalledWith('backup-a', expect.objectContaining({ status: 'completed' }));
});
it('restores a no-provider MinIO backup from the default target', async () => {
  mockDefaultType = 'minio';
  mockRepos.DbBackup.findOne.mockResolvedValue({ ...backup, providerType: 'minio', providerId: null });
  expect((await request(app).post(`/projects/${projectId}/databases/backups/backup-a/restore`)).status).toBe(202);
  await settle();
  expect(mockCreateAdapter).toHaveBeenCalledWith('default', 'minio');
  expect(mockRestore).toHaveBeenCalled();
});
it('records the provider identity on upload', async () => {
  mockRepos.StorageProvider.findOne.mockResolvedValue({ id: 'original-provider', providerType: 's3', credentials: {} });
  expect((await request(app).post(`/projects/${projectId}/databases/backup`).send({ dbName: 'project_db' })).status).toBe(202);
  await settle();
  expect(mockRepos.DbBackup.create).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'original-provider' }));
});
it('restores from the original provider rather than the current default', async () => {
  expect((await request(app).post(`/projects/${projectId}/databases/backups/backup-a/restore`)).status).toBe(202);
  await settle();
  expect(mockRepos.StorageProvider.findOne).toHaveBeenCalledWith({ where: { id: 'original-provider' } });
  expect(mockCreateAdapter).toHaveBeenCalledWith('s3', { region: 'original' }, undefined, undefined);
  expect(mockRestore).toHaveBeenCalled();
});
it.each(['missing', 'checksum'])('does not restore when the dump has a %s failure', async (failure) => {
  if (failure === 'missing') mockDownload.mockRejectedValueOnce(new Error('missing dump'));
  else mockChecksum.mockResolvedValueOnce('wrong');
  expect((await request(app).post(`/projects/${projectId}/databases/backups/backup-a/restore`)).status).toBe(202);
  await settle();
  expect(mockRestore).not.toHaveBeenCalled();
  expect(mockRepos.DbBackup.update).toHaveBeenCalledWith('backup-a', expect.objectContaining({ status: 'failed' }));
});
it('rejects a database outside the project identity', async () => {
  expect((await request(app).post(`/projects/${projectId}/databases/backup`).send({ dbName: 'platform_database' })).status).toBe(400);
  expect(mockUpload).not.toHaveBeenCalled();
});
