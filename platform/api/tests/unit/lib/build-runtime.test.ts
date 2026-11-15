const mockCore = { listNamespacedPod: jest.fn(), readNamespacedPodLog: jest.fn(), createNamespacedSecret: jest.fn(), replaceNamespacedSecret: jest.fn(), readNamespacedSecret: jest.fn(), patchNamespacedSecret: jest.fn(), deleteNamespacedSecret: jest.fn() };
const mockBatch = { readNamespacedJob: jest.fn(), listNamespacedJob: jest.fn(), createNamespacedJob: jest.fn(), deleteNamespacedJob: jest.fn() };
jest.mock('@kubernetes/client-node', () => ({ CoreV1Api: 'core', BatchV1Api: 'batch', PatchStrategy: { MergePatch: 'application/merge-patch+json' }, setHeaderOptions: (key: string, value: string) => ({ headers: { [key]: value } }), KubeConfig: class { makeApiClient(type: string) { return type === 'core' ? mockCore : mockBatch; } } }));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
const mockMint = jest.fn();
const mockRevoke = jest.fn(async (..._a: any[]) => undefined);
jest.mock('../../../src/lib/build-source', () => ({ mintCloneCredential: (...a: any[]) => mockMint(...a), revokeCloneCredential: (...a: any[]) => mockRevoke(...a) }));
const mockRelease = jest.fn();
jest.mock('../../../src/lib/locks', () => ({ acquireLock: jest.fn(async () => ({ release: mockRelease })) }));
const mockAxios = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { request: (...a: any[]) => mockAxios(...a) } }));
import crypto from 'crypto';
import { BuildStopped, registryManifest, runBuildJob, scrubBuildLogs, signBuiltImage } from '../../../src/lib/build-runtime';
import { setRegistrySignerForTests } from '../../../src/lib/registry-token';

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const digest = `sha256:${'d'.repeat(64)}`;
const source = { repositoryUrl: 'https://github.com/acme/app.git', repositoryApprovedAt: new Date(), repositoryApprovedKey: 'github.com/acme/app' };
const internal = 'registry.registry.svc.cluster.local:5000/p-p1/e-e1';
let build: any;
const running = { metadata: { uid: 'uid', creationTimestamp: new Date().toISOString() }, status: { active: 1 } };
const success = { metadata: { uid: 'uid', creationTimestamp: new Date().toISOString() }, status: { succeeded: 1 } };
const pod = (message = `${internal}@${digest}`, container = 'publish') => ({ metadata: { name: 'pod' }, status: {
  initContainerStatuses: [{ name: 'clone', state: { terminated: { exitCode: 0 } } }],
  containerStatuses: [{ name: container, state: { terminated: { exitCode: 0, message } } }] } });
const hooks = () => ({ saveLogs: jest.fn(async () => undefined), stillQueued: jest.fn(async () => true), markSubmitted: jest.fn(async () => undefined) });
const cloneSecret = { data: { header: Buffer.from('Authorization: Basic eDp0b2tlbg==').toString('base64'), secret: Buffer.from('ghs_clone_secret').toString('base64'),
  revoke: Buffer.from(JSON.stringify({ provider: 'github', token: 'ghs_clone_secret' })).toString('base64') } };

beforeAll(() => setRegistrySignerForTests(privateKey));
afterAll(() => setRegistrySignerForTests(null));
beforeEach(() => {
  jest.clearAllMocks();
  build = { id: 'b', projectId: 'p1', environmentId: 'e1', commitSha: 'a'.repeat(40), imageTag: `registry.example.com/p-p1/e-e1:${'a'.repeat(40)}`, jobSubmittedAt: null };
  process.env.BUILDS_MAX_CONCURRENT = '2'; process.env.BUILDS_MAX_ACTIVE_PER_PROJECT = '1'; delete process.env.BUILDS_REQUIRE_SIGNATURE;
  process.env.BUILDS_REGISTRY = 'registry.example.com';
  mockMint.mockResolvedValue({ url: 'https://github.com/acme/app.git', header: 'Authorization: Basic eDpnaHNfY2xvbmVfc2VjcmV0', secret: 'ghs_clone_secret', revoke: { provider: 'github', token: 'ghs_clone_secret' } });
  mockCore.listNamespacedPod.mockResolvedValue({ items: [pod()] });
  mockCore.readNamespacedPodLog.mockResolvedValue('');
  mockCore.readNamespacedSecret.mockImplementation(async ({ name }: any) => { if (name === 'build-b-git') return cloneSecret; throw { code: 404 }; });
  mockBatch.createNamespacedJob.mockResolvedValue(running);
  mockBatch.listNamespacedJob.mockResolvedValue({ items: [] });
  jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => { queueMicrotask(callback); return 0; }) as any);
});
afterEach(() => jest.restoreAllMocks());

it('waits for global and per-project admission, then submits once with separate credential Secrets', async () => {
  mockBatch.readNamespacedJob.mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce({ code: 404 }).mockResolvedValue(success);
  mockBatch.listNamespacedJob
    .mockResolvedValueOnce({ items: [{ metadata: { labels: { 'cairn.dev/project': 'other' } } }, { metadata: { labels: { 'cairn.dev/project': 'other' } } }] }) // global cap
    .mockResolvedValueOnce({ items: [{ metadata: { labels: { 'cairn.dev/project': 'p1' } } }] }) // this project's cap
    .mockResolvedValueOnce({ items: [{ metadata: { labels: { 'cairn.dev/project': 'other' } } }] });
  const h = hooks();
  expect(await runBuildJob(build, source, h)).toBe(digest);
  expect(mockBatch.listNamespacedJob).toHaveBeenCalledTimes(3);
  expect(mockBatch.createNamespacedJob).toHaveBeenCalledTimes(1);
  expect(h.markSubmitted).toHaveBeenCalledTimes(1);
  expect(build.jobSubmittedAt).toBeInstanceOf(Date);
  const jobText = JSON.stringify(mockBatch.createNamespacedJob.mock.calls);
  expect(jobText).not.toMatch(/ghs_clone_secret|eyJ/);
  const secrets = Object.fromEntries(mockCore.createNamespacedSecret.mock.calls.map((c: any) => [c[0].body.metadata.name, c[0].body.stringData]));
  expect(Object.keys(secrets).sort()).toEqual(['build-b-git', 'build-b-push']);
  expect(secrets['build-b-git'].header).toContain('Authorization: Basic');
  expect(JSON.parse(secrets['build-b-push']['config.json']).auths['registry.registry.svc.cluster.local:5000'].registrytoken).toMatch(/^eyJ/);
  expect(JSON.stringify(secrets['build-b-push'])).not.toContain('ghs_clone_secret');
  expect(mockCore.patchNamespacedSecret).toHaveBeenCalledTimes(2);
  expect(mockCore.patchNamespacedSecret.mock.calls[0][0].body.metadata.ownerReferences[0].uid).toBe('uid');
  // The owner reference is a merge patch; the client's default (JSON Patch) is rejected by the API server.
  expect(mockCore.patchNamespacedSecret.mock.calls[0][1]).toEqual({ headers: { 'Content-Type': 'application/merge-patch+json' } });
});

it('revokes the Git credential as soon as the clone step has finished', async () => {
  mockBatch.readNamespacedJob.mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce(running).mockResolvedValue(success);
  await runBuildJob(build, source, hooks());
  expect(mockRevoke).toHaveBeenCalledWith({ provider: 'github', token: 'ghs_clone_secret' });
  expect(mockCore.deleteNamespacedSecret).toHaveBeenCalledWith({ namespace: 'builds', name: 'build-b-git' });
  expect(mockCore.deleteNamespacedSecret).not.toHaveBeenCalledWith({ namespace: 'builds', name: 'build-b-push' });
});

it('reattaches to an existing Job without minting credentials or creating a second Job', async () => {
  mockBatch.readNamespacedJob.mockResolvedValue(success);
  expect(await runBuildJob(build, source, hooks())).toBe(digest);
  expect(mockBatch.createNamespacedJob).not.toHaveBeenCalled();
  expect(mockMint).not.toHaveBeenCalled();
});

it('never re-runs a build whose Job was already submitted (timed out or expired)', async () => {
  build.jobSubmittedAt = new Date();
  mockBatch.readNamespacedJob.mockRejectedValue({ code: 404 });
  await expect(runBuildJob(build, source, hooks())).rejects.toBeInstanceOf(BuildStopped);
  expect(mockBatch.createNamespacedJob).not.toHaveBeenCalled();
  expect(mockMint).not.toHaveBeenCalled();
});

it('stops a superseded build before it is admitted', async () => {
  mockBatch.readNamespacedJob.mockRejectedValue({ code: 404 });
  const h = hooks(); h.stillQueued.mockResolvedValue(false);
  await expect(runBuildJob(build, source, h)).rejects.toThrow('superseded');
  expect(mockMint).not.toHaveBeenCalled();
});

it('revokes a minted clone credential when the Job cannot be created', async () => {
  mockBatch.readNamespacedJob.mockRejectedValue({ code: 404 });
  mockBatch.createNamespacedJob.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(runBuildJob(build, source, hooks())).rejects.toThrow('quota');
  expect(mockRevoke).toHaveBeenCalled();
  expect(mockCore.deleteNamespacedSecret).toHaveBeenCalledWith({ namespace: 'builds', name: 'build-b-push' });
});

it('reports Job failure after saving the final logs', async () => {
  mockBatch.readNamespacedJob.mockResolvedValue({ status: { failed: 1 } });
  const h = hooks();
  await expect(runBuildJob(build, source, h)).rejects.toThrow('Build Job failed');
  expect(h.saveLogs).toHaveBeenCalled();
});

it('uses only the digest reported by a trusted step, never a tag lookup', async () => {
  mockBatch.readNamespacedJob.mockResolvedValue(success);
  // An untrusted step's termination message is ignored even if it names a valid digest.
  mockCore.listNamespacedPod.mockResolvedValue({ items: [pod(`${internal}@${digest}`, 'buildkit')] });
  await expect(runBuildJob(build, source, hooks())).rejects.toThrow('no image digest');
  mockCore.listNamespacedPod.mockResolvedValue({ items: [pod(`registry.registry.svc.cluster.local:5000/p-other/e-e1@${digest}`)] });
  await expect(runBuildJob(build, source, hooks())).rejects.toThrow('no image digest');
  expect(mockAxios).not.toHaveBeenCalled();
  mockCore.listNamespacedPod.mockResolvedValue({ items: [pod(`${internal}@${digest}`, 'export')] });
  expect(await runBuildJob(build, source, hooks())).toBe(digest);
});

it('redacts credentials, registry tokens and bounds stored logs', () => {
  const token = 'private-token'; const encoded = Buffer.from(`x:${token}`).toString('base64');
  const header = `Authorization: Basic ${encoded}`;
  const jwtLike = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJidWlsZCJ9.c2lnbmF0dXJlLXZhbHVl';
  const logs = scrubBuildLogs(`${'x'.repeat(210_000)} ${header} ${token} ${encoded} https://user:pass@github.com ghp_abc gldt-abc ${jwtLike}`, header);
  expect(logs.length).toBeLessThanOrEqual(200_000);
  for (const secret of [token, encoded, 'user:pass', 'gldt-abc', jwtLike]) expect(logs).not.toContain(secret);
});

it('distinguishes a missing manifest from other registry failures', async () => {
  const { RegistryNotFoundError } = jest.requireActual('../../../src/lib/build-runtime');
  mockAxios.mockResolvedValueOnce({ status: 404, headers: {} });
  await expect(registryManifest('registry.example.com/p-p1/e-e1:cache')).rejects.toBeInstanceOf(RegistryNotFoundError);
  mockAxios.mockResolvedValueOnce({ status: 503, headers: {} });
  const failure = registryManifest('registry.example.com/p-p1/e-e1:cache');
  await expect(failure).rejects.toThrow('503');
  await expect(failure).rejects.not.toBeInstanceOf(RegistryNotFoundError);
});

it('deletes manifests in-cluster as the retention identity', async () => {
  mockAxios.mockResolvedValue({ status: 202, headers: {} });
  await registryManifest(`registry.example.com/p-p1/e-e1@${digest}`, 'DELETE');
  const req = mockAxios.mock.calls[0][0];
  expect(req.url).toBe(`http://registry.registry.svc.cluster.local:5000/v2/p-p1/e-e1/manifests/${digest}`);
  const claims = JSON.parse(Buffer.from(req.headers.Authorization.split(' ')[1].split('.')[1], 'base64url').toString());
  expect(claims.access).toEqual([{ type: 'repository', name: 'p-p1/e-e1', actions: ['pull', 'delete'] }]);
  await expect(registryManifest('elsewhere.example/p-p1/e-e1:tag')).rejects.toThrow('Invalid');
});

it('fails closed when signatures are required without a cluster identity', async () => {
  process.env.BUILDS_REQUIRE_SIGNATURE = 'true';
  await expect(signBuiltImage(`registry/p@${digest}`)).rejects.toThrow('identity');
});
