import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';

const mockFiles = new Map<string, any>();
const mockProviders = new Map<string, any>();
const mockSend = jest.fn();
const mockProject = '10000000-0000-4000-8000-000000000001';
jest.mock('../../src/middleware/auth', () => ({
  sdkOrUserAuthenticate: (req: any, _res: any, next: any) => { req.sdkToken = {}; req.projectId = mockProject; next(); },
  sdkProjectMatches: () => true,
  expressAuthenticate: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../src/config/database', () => ({ getDb: async () => ({ getRepository: (entity: any) => {
  const rows = entity.name === 'File' ? mockFiles : mockProviders;
  return {
    create: (p: any) => ({ isDeleted: false, ...p }),
    save: async (p: any) => { rows.set(p.id, { ...p }); return p; },
    findOne: async ({ where }: any) => [...rows.values()].find(p => Object.entries(where).every(([k,v]) => p[k] === v)) || null,
  };
} }) }));
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: any) {} }
  return { S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    PutObjectCommand: class Put extends Command {}, GetObjectCommand: class Get extends Command {}, DeleteObjectCommand: class Delete extends Command {} };
});
import router from '../../src/routes/storage';
const app = express(); app.use(express.json()); app.use('/api', router);

beforeEach(() => {
  mockFiles.clear(); mockProviders.clear(); mockSend.mockReset();
  mockSend.mockImplementation(async cmd => {
    if (cmd.input.Body) for await (const _chunk of cmd.input.Body) { /* consume source */ }
    return cmd.constructor.name === 'Get' ? { Body: Readable.from('file contents') } : {};
  });
});
it('SDK uploads follow the default; registered files retain the original provider after switching', async () => {
  const first = { id: randomUUID(), name: 'first', providerType: 's3', isDefault: true, bucketName: 'first-bucket', endpointUrl: 'https://objects.example.com', credentials: { accessKeyId: 'key', secretAccessKey: 'secret' } };
  const second = { ...first, id: randomUUID(), name: 'second', bucketName: 'second-bucket', isDefault: false };
  mockProviders.set(first.id, first); mockProviders.set(second.id, second);
  const registration = await request(app).post('/api/storage/upload-url').send({ fileName: 'one.txt' }).expect(201);
  const id = registration.body.fileId;
  expect(mockFiles.get(id).storageProviderId).toBe(first.id);
  first.isDefault = false; second.isDefault = true;
  await request(app).put(`/api/storage/upload-raw/${id}`).set('Content-Type', 'application/octet-stream').send('file contents').expect(200);
  expect(mockSend.mock.calls[0][0].input.Bucket).toBe('first-bucket');
  const next = await request(app).post('/api/storage/upload-url').send({ fileName: 'two.txt' }).expect(201);
  expect(mockFiles.get(next.body.fileId).storageProviderId).toBe(second.id);
  expect(mockFiles.get(next.body.fileId).bucket).toBe('second-bucket');
  await request(app).get(`/api/storage/file/${id}`).expect(200);
  expect(mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input.Bucket).toBe('first-bucket');
  await request(app).post('/api/storage/delete').send({ fileId: id }).expect(200);
  expect(mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input.Bucket).toBe('first-bucket');
});
it('fails closed when a recorded provider is missing', async () => {
  const id = randomUUID();
  mockFiles.set(id, { id, projectId: mockProject, isDeleted: false, storageProviderId: randomUUID() });
  const result = await request(app).get(`/api/storage/file/${id}`).expect(400);
  expect(result.body.error).toBe('Original storage provider is unavailable');
  expect(mockSend).not.toHaveBeenCalled();
});
