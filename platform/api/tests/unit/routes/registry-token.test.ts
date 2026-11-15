import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
const mockFindProject = jest.fn();
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: () => ({ findOneBy: (...a: any[]) => mockFindProject(...a) }) }) }));
import router from '../../../src/routes/registry-token';
import { pullCredential, setRegistrySignerForTests } from '../../../src/lib/registry-token';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const app = express(); app.use(router);
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
beforeAll(() => setRegistrySignerForTests(privateKey));
afterAll(() => setRegistrySignerForTests(null));
beforeEach(() => { mockFindProject.mockReset(); mockFindProject.mockResolvedValue({ id: 'project-a', isActive: true }); });

it('exchanges a project pull credential for a pull-only token on that project\'s repositories', async () => {
  const cred = await pullCredential('project-a');
  const res = await request(app).get('/registry/token')
    .query({ service: 'cairn-registry', scope: ['repository:p-project-a/e-env1:pull,push', 'repository:p-project-b/e-env1:pull'] })
    .set('Authorization', basic(cred.username, cred.password));
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  const claims: any = jwt.verify(res.body.token, publicKey, { algorithms: ['ES256'] });
  expect(claims.access).toEqual([{ type: 'repository', name: 'p-project-a/e-env1', actions: ['pull'] }]);
  expect(claims.exp - claims.iat).toBe(300);
  expect(mockFindProject).toHaveBeenCalledWith({ id: 'project-a', isActive: true });
});

it('cannot be used by one project to read another project\'s images', async () => {
  const cred = await pullCredential('project-a');
  const res = await request(app).get('/registry/token').query({ service: 'cairn-registry', scope: 'repository:p-project-b/e-env1:pull' })
    .set('Authorization', basic('pull.project-b', cred.password));
  expect(res.status).toBe(401);
});

it('rejects missing credentials, deleted projects and unknown services', async () => {
  expect((await request(app).get('/registry/token').query({ service: 'cairn-registry' })).status).toBe(401);
  const cred = await pullCredential('project-a');
  mockFindProject.mockResolvedValue(null);
  expect((await request(app).get('/registry/token').query({ service: 'cairn-registry' }).set('Authorization', basic(cred.username, cred.password))).status).toBe(401);
  expect((await request(app).get('/registry/token').query({ service: 'other' }).set('Authorization', basic(cred.username, cred.password))).status).toBe(400);
});

it('answers the OAuth2 POST probe with 404 so clients fall back to GET', async () => {
  expect((await request(app).post('/registry/token')).status).toBe(404);
});
