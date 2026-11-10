import fs from 'fs';
import os from 'os';
import path from 'path';

const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-migration-test-'));
const mockFiles: any[] = [];
const mockPut = jest.fn();
const mockProvider = { id: 'destination', providerType: 's3' };
jest.mock('../../src/config/database', () => ({ getDb: async () => ({ getRepository: (entity: any) => entity.name === 'File' ? {
  find: async () => mockFiles.filter(f => f.provider === 'local' && !f.isDeleted && f.size !== null),
  update: async (id: string, patch: any) => Object.assign(mockFiles.find(f => f.id === id), patch),
} : { findOneBy: async () => mockProvider } }) }));
jest.mock('../../src/lib/upload-store', () => ({ containedUploadPath: (name: string) => path.join(mockRoot, path.basename(name)) }));
jest.mock('../../src/lib/provider-upload-store', () => ({ providerUploadStore: () => ({ bucket: 'destination-bucket', put: mockPut }) }));
import '../../src/lib/storage-migrate-op';
import { getOperationDefinition } from '../../src/lib/operations';

afterAll(() => fs.rmSync(mockRoot, { recursive: true, force: true }));
it('checkpoints each copied file, retries remaining files, and preserves originals', async () => {
  for (const id of ['first', 'second']) {
    mockFiles.push({ id, projectId: 'project', originalName: id, provider: 'local', isDeleted: false, size: 3 });
    fs.writeFileSync(path.join(mockRoot, id), 'abc');
  }
  // Incomplete upload registrations are excluded from migration.
  mockFiles.push({ id: 'pending', provider: 'local', isDeleted: false, size: null });
  const keys: string[] = [];
  mockPut.mockImplementation(async (key: string, source: string) => {
    expect(fs.readFileSync(source, 'utf8')).toBe('abc');
    keys.push(key);
    if (key === 'project/second') throw new Error('interrupted');
  });
  const step = getOperationDefinition('storage.migrate-local')!.steps[0];
  const ctx: any = { input: { providerId: 'destination' }, setOutput: jest.fn() };
  await expect(step.run(ctx)).rejects.toThrow('interrupted');
  expect(mockFiles[0].storageProviderId).toBe('destination');
  expect(mockFiles[1].provider).toBe('local');
  mockPut.mockImplementation(async (key: string) => { keys.push(key); });
  await step.run(ctx);
  expect(keys).toEqual(['project/first', 'project/second', 'project/second']);
  expect(mockFiles[1].storageProviderId).toBe('destination');
  expect(fs.readFileSync(path.join(mockRoot, 'first'), 'utf8')).toBe('abc');
  expect(fs.readFileSync(path.join(mockRoot, 'second'), 'utf8')).toBe('abc');
  expect(mockFiles[2].storageProviderId).toBeUndefined();
});
