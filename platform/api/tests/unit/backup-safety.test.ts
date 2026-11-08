import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
const mockConnect = jest.fn();
const mockSpawn = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ connect: mockConnect })) }));
jest.mock('child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args) }));
import { restoreDatabase } from '../../src/lib/database-service';
import { LocalAdapter } from '../../src/lib/storage-service';

describe('backup durability and restore preflight', () => {
  let directory: string;
  beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-backup-test-'));
    mockSpawn.mockImplementation(() => {
      const process: any = new EventEmitter(); process.stderr = new EventEmitter();
      setImmediate(() => process.emit('close', 0));
      return process;
    });
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
  it('keeps a readable dump after deleting the temporary source', async () => {
    const source = path.join(directory, 'source.dump');
    const restored = path.join(directory, 'restored.dump');
    fs.writeFileSync(source, 'dump bytes');
    process.env.BACKUP_DIR = path.join(directory, 'persisted');
    const adapter = new LocalAdapter();
    const uploaded = await adapter.upload(source, 'backups/project-id/backup-id.dump');
    fs.unlinkSync(source);
    await adapter.download(uploaded.fileId, restored);
    expect(fs.readFileSync(restored, 'utf8')).toBe('dump bytes');
    delete process.env.BACKUP_DIR;
  });
  it('rejects paths outside the local backup root', async () => {
    const adapter = new LocalAdapter(directory);
    await expect(adapter.download('../outside', path.join(directory, 'out'))).rejects.toThrow('Invalid backup path');
  });
  it.each(['missing.dump', 'empty.dump'])('does not touch the database for %s', async (name) => {
    const file = path.join(directory, name);
    if (name === 'empty.dump') fs.writeFileSync(file, '');
    expect((await restoreDatabase('live', file)).success).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it('restores inside one transaction without dropping the database', async () => {
    const file = path.join(directory, 'valid.dump'); fs.writeFileSync(file, 'dump');
    expect((await restoreDatabase('live', file)).success).toBe(true);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockSpawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--clean', '--if-exists', '--single-transaction', '--exit-on-error']));
  });
  it('reports pg_restore failure even when stderr says already exists', async () => {
    const file = path.join(directory, 'valid.dump'); fs.writeFileSync(file, 'dump');
    mockSpawn.mockImplementationOnce(() => {
      const process: any = new EventEmitter(); process.stderr = new EventEmitter();
      setImmediate(() => { process.stderr.emit('data', 'already exists'); process.emit('close', 1); });
      return process;
    });
    expect((await restoreDatabase('live', file)).success).toBe(false);
  });
});
