import { fetchSecrets } from '../../../src/lib/infisical';

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(),
}));

jest.mock('../../../src/lib/secrets-encryption', () => ({
  decryptValue: jest.fn((v: string) => `plain:${v}`),
}));

const { getDb } = require('../../../src/config/database');
const { decryptValue } = require('../../../src/lib/secrets-encryption');

describe('Infisical Library (DB-backed secrets)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SECRETS_ENCRYPTION_KEY;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return empty object when encryption key is missing', async () => {
    getDb.mockResolvedValue({
      getRepository: () => ({
        find: jest.fn().mockResolvedValue([{ key: 'DB_HOST', encryptedValue: 'enc' }]),
      }),
    });
    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });

  it('should decrypt secrets from the database when key is set', async () => {
    process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
    const find = jest.fn().mockResolvedValue([
      { key: 'DB_HOST', encryptedValue: 'enc-host' },
      { key: 'DB_PORT', encryptedValue: 'enc-port' },
    ]);
    getDb.mockResolvedValue({
      getRepository: () => ({ find }),
    });

    const result = await fetchSecrets('project-1', 'env-1');

    expect(find).toHaveBeenCalledWith({
      where: { projectId: 'project-1', environmentId: 'env-1', isActive: true },
    });
    expect(decryptValue).toHaveBeenCalled();
    expect(result).toEqual({
      DB_HOST: 'plain:enc-host',
      DB_PORT: 'plain:enc-port',
    });
  });

  it('should return empty object on database error', async () => {
    process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
    getDb.mockRejectedValue(new Error('db down'));
    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });

  it('should return empty object when no secrets exist', async () => {
    process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
    getDb.mockResolvedValue({
      getRepository: () => ({
        find: jest.fn().mockResolvedValue([]),
      }),
    });
    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });
});
