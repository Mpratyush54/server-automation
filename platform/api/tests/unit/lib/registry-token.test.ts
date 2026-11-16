import crypto from 'crypto';
import jwt from 'jsonwebtoken';
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
import {
  REGISTRY_INTERNAL_HOST, buildPushToken, buildRepository, libtrustKeyId, pullAccessFor, pullCredential, pushCnbAuth, pushDockerConfig,
  retentionToken, setRegistrySignerForTests, verifyPullCredential, mintRegistryToken,
} from '../../../src/lib/registry-token';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
beforeAll(() => setRegistrySignerForTests(privateKey));
afterAll(() => setRegistrySignerForTests(null));
const decode = (token: string) => jwt.verify(token, publicKey, { algorithms: ['ES256'], audience: 'cairn-registry', issuer: 'cairn-api' }) as any;

it('derives the same libtrust key ID the registry computes from its root certificate', () => {
  // Vector produced with the libtrust keyIDFromCryptoKey algorithm (Go) for this public key.
  const pem = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfBkJ6Ozs31A6WvnNoML0FmqgXsgv\n5VxqJI6G5CTQlKsxzsrozwM79YidbzBJeRYvn6syvhAr42kVpHeOqLy0dg==\n-----END PUBLIC KEY-----\n';
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
  expect(libtrustKeyId(der)).toBe('EUI6:WLDM:UC3Y:FCUA:5SLR:OFPK:3H54:5QHV:TVWC:2NIT:43JU:4DTQ');
});

it('signs ES256 tokens with a kid header the registry can match', async () => {
  const token = await buildPushToken('p1', 'e1', 'b1', 600);
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: libtrustKeyId(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }) as Buffer) });
  const claims = decode(token);
  expect(claims.exp - claims.iat).toBe(600);
});

it('scopes a build push token to exactly its own environment repository, without delete', async () => {
  const claims = decode(await buildPushToken('p1', 'e1', 'b1', 600));
  expect(claims.sub).toBe('build:b1');
  expect(claims.access).toEqual([{ type: 'repository', name: 'p-p1/e-e1', actions: ['pull', 'push'] }]);
});

it('grants delete only to the retention identity', async () => {
  const claims = decode(await retentionToken('p-p1/e-e1'));
  expect(claims.sub).toBe('cairn-retention');
  expect(claims.access[0].actions).toEqual(['pull', 'delete']);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
});

it('refuses malformed repository names', async () => {
  expect(() => buildRepository('p1/../x', 'e1')).toThrow();
  await expect(mintRegistryToken('x', [{ type: 'repository', name: '*', actions: ['pull'] }], 60)).rejects.toThrow();
});

it('formats push credentials for crane and the lifecycle against the in-cluster registry only', () => {
  expect(JSON.parse(pushDockerConfig('tok'))).toEqual({ auths: { [REGISTRY_INTERNAL_HOST]: { registrytoken: 'tok' } } });
  expect(JSON.parse(pushCnbAuth('tok'))).toEqual({ [REGISTRY_INTERNAL_HOST]: 'Bearer tok' });
});

describe('per-project pull credentials', () => {
  it('verify only for the project they were issued to', async () => {
    const a = await pullCredential('project-a');
    const b = await pullCredential('project-b');
    expect(a.password).not.toBe(b.password);
    expect(await verifyPullCredential(a.username, a.password)).toBe('project-a');
    expect(await verifyPullCredential('pull.project-b', a.password)).toBeNull();
    expect(await verifyPullCredential(a.username, `${a.password}x`)).toBeNull();
    expect(await verifyPullCredential('cairn', a.password)).toBeNull();
  });

  it('yield pull access to the project\'s own repositories only, never push or delete', () => {
    const access = pullAccessFor('project-a', [
      'repository:p-project-a/e-env1:pull,push',
      'repository:p-project-b/e-env1:pull',
      'repository:p-project-a/e-env2:delete',
      'repository:p-project-ab/e-env1:pull',
      'registry:catalog:*',
      'repository:p-project-a/e-env3:pull repository:p-project-a/e-env1:pull',
    ]);
    expect(access).toEqual([
      { type: 'repository', name: 'p-project-a/e-env1', actions: ['pull'] },
      { type: 'repository', name: 'p-project-a/e-env3', actions: ['pull'] },
    ]);
  });
});
