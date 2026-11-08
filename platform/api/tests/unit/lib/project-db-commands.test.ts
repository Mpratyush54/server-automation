/**
 * Per-project MongoDB / Redis credential commands (no live database needed) and the
 * legacy-compatible encryption key order for stored project secrets.
 */
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockRejectedValue(new Error('no db in unit tests')),
}));

import {
  buildMongoUserCommand,
  buildProjectMongoUri,
  buildRedisAclSetUserArgs,
  parseMongoUri,
  secretWriteKey,
  decryptStoredSecret,
} from '../../../src/lib/project-db-ensure';
import { encryptValue, decryptValue } from '../../../src/lib/secrets-encryption';

describe('MongoDB user commands', () => {
  it('createUser grants readWrite on only the project database', () => {
    expect(buildMongoUserCommand('plat_a_b', 'plat_a_b_user', 'pw', false)).toEqual({
      createUser: 'plat_a_b_user', pwd: 'pw', roles: [{ role: 'readWrite', db: 'plat_a_b' }],
    });
  });

  it('updateUser resets password and roles for an existing user', () => {
    expect(buildMongoUserCommand('plat_a_b', 'plat_a_b_user', 'pw2', true)).toEqual({
      updateUser: 'plat_a_b_user', pwd: 'pw2', roles: [{ role: 'readWrite', db: 'plat_a_b' }],
    });
  });

  it('project URI keeps hosts/options but never the platform credentials or authSource', () => {
    const uri = buildProjectMongoUri(
      'mongodb://root:s3cr3t@m0:27017,m1:27017/plat_platform?replicaSet=rs0&authSource=admin&authMechanism=SCRAM-SHA-1&tls=true',
      'plat_a_b', 'plat_a_b_user', 'p@ss/word',
    );
    expect(uri).toBe('mongodb://plat_a_b_user:p%40ss%2Fword@m0:27017,m1:27017/plat_a_b?replicaSet=rs0&tls=true&authSource=plat_a_b');
    expect(uri).not.toMatch(/root|s3cr3t|admin|SCRAM/);
  });

  it('supports mongodb+srv and URIs without credentials', () => {
    expect(buildProjectMongoUri('mongodb+srv://cluster.example.net', 'd', 'u', 'p'))
      .toBe('mongodb+srv://u:p@cluster.example.net/d?authSource=d');
    expect(parseMongoUri('mongodb://root:x@h:1/plat_platform')).toMatchObject({ username: 'root', hosts: 'h:1', database: 'plat_platform' });
    expect(() => parseMongoUri('http://nope')).toThrow(/mongodb/);
  });
});

describe('Redis ACL command', () => {
  it('confines the user to its key and channel prefix without admin/dangerous commands', () => {
    expect(buildRedisAclSetUserArgs('plat_a_b', 'Secret123', 'plat:a:b:')).toEqual([
      'SETUSER', 'plat_a_b', 'reset', 'on', '>Secret123', '~plat:a:b:*', '&plat:a:b:*', '+@all', '-@admin', '-@dangerous',
    ]);
  });

  it.each([
    ['default', 'pw', 'plat:a:'],
    ['plat a', 'pw', 'plat:a:'],
    ['plat_a', 'pw', ''],
    ['plat_a', 'pw', 'plat:*'],
    ['plat_a', 'pw with space', 'plat:a:'],
    ['plat_a', '', 'plat:a:'],
  ])('rejects unsafe user=%p password=%p prefix=%p', (user, pw, prefix) => {
    expect(() => buildRedisAclSetUserArgs(user, pw, prefix)).toThrow();
  });
});

describe('stored secret encryption keys', () => {
  const ENC = 'e'.repeat(64);
  const JWT = 'j'.repeat(48);

  it('encrypts new data with SECRETS_ENCRYPTION_KEY when set', () => {
    const key = secretWriteKey({ SECRETS_ENCRYPTION_KEY: ENC, JWT_SECRET: JWT } as any);
    expect(key).toBe(ENC);
    expect(decryptValue(encryptValue('v', key), ENC)).toBe('v');
  });

  it('falls back to JWT_SECRET only when SECRETS_ENCRYPTION_KEY is unset, never to a constant', () => {
    expect(secretWriteKey({ JWT_SECRET: JWT } as any)).toBe(JWT);
    expect(() => secretWriteKey({} as any)).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('decrypts with SECRETS_ENCRYPTION_KEY first, then legacy JWT_SECRET', () => {
    const env = { SECRETS_ENCRYPTION_KEY: ENC, JWT_SECRET: JWT } as any;
    expect(decryptStoredSecret(encryptValue('new', ENC), env)).toBe('new');
    expect(decryptStoredSecret(encryptValue('legacy', JWT), env)).toBe('legacy');
    expect(() => decryptStoredSecret(encryptValue('other', 'x'.repeat(40)), env)).toThrow();
  });
});
