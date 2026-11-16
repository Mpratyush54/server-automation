import crypto from 'crypto';
const mockRead = jest.fn();
jest.mock('@kubernetes/client-node', () => ({ CoreV1Api: 'core', KubeConfig: class { makeApiClient() { return { readNamespacedSecret: (...a: any[]) => mockRead(...a) }; } } }));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
import { registrySignerKid } from '../../../src/lib/registry-token';

it('reads the registry signing key from the platform namespace', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  mockRead.mockResolvedValue({ data: { 'key.pem': Buffer.from(privateKey).toString('base64') } });
  expect(await registrySignerKid()).toMatch(/^[A-Z2-7]{4}(:[A-Z2-7]{4}){11}$/);
  expect(mockRead).toHaveBeenCalledWith({ namespace: 'platform', name: 'registry-token-signer' });
});
