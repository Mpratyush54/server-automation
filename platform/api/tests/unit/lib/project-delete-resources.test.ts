/**
 * Ownership checks of the project-deletion resource layer: only namespaces, Argo CD
 * Applications and databases provably owned by the project id are removed.
 */
const mockCore: any = { readNamespace: jest.fn(), deleteNamespace: jest.fn() };
const mockCustom: any = { listNamespacedCustomObject: jest.fn(), replaceNamespacedCustomObject: jest.fn(), deleteNamespacedCustomObject: jest.fn() };
jest.mock('@kubernetes/client-node', () => {
  const CoreV1Api = function CoreV1Api() {};
  const CustomObjectsApi = function CustomObjectsApi() {};
  const AppsV1Api = function AppsV1Api() {};
  const NetworkingV1Api = function NetworkingV1Api() {};
  const RbacAuthorizationV1Api = function RbacAuthorizationV1Api() {};
  const clients = new Map<any, any>([[CoreV1Api, mockCore], [CustomObjectsApi, mockCustom]]);
  return {
    KubeConfig: class { loadFromCluster() {} loadFromDefault() {} makeApiClient(api: any) { return clients.get(api) || {}; } },
    CoreV1Api, CustomObjectsApi, AppsV1Api, NetworkingV1Api, RbacAuthorizationV1Api,
  };
});
const mockSecrets: any[] = [];
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: () => ({ find: async () => mockSecrets }) })),
}));
jest.mock('../../../src/lib/project-db-ensure', () => ({ decryptStoredSecret: (v: string) => v }));

import { listProjectDatabases, removeArgoApplications, removeNamespaces } from '../../../src/lib/project-delete-resources';
import { projectDbIdentity } from '../../../src/lib/project-db-identity';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const gone = () => Object.assign(new Error('not found'), { code: 404 });
const nsWithOwner: Record<string, string | undefined> = { 'shop-prod-1': P, 'shop-staging': OTHER, 'legacy-ns': undefined };

beforeEach(() => {
  jest.clearAllMocks();
  mockSecrets.length = 0;
  mockCore.readNamespace.mockImplementation(async ({ name }: any) => {
    if (!(name in nsWithOwner)) throw gone();
    return { metadata: { name, labels: nsWithOwner[name] ? { 'platform.io/project': nsWithOwner[name] } : {} } };
  });
});

it('deletes only namespaces labelled with the project id, never reserved ones', async () => {
  const out = await removeNamespaces(P, ['shop-prod-1', 'shop-staging', 'legacy-ns', 'already-gone', 'platform', 'kube-system']);
  expect(out).toEqual({
    'shop-prod-1': 'deleted', 'shop-staging': 'not-owned', 'legacy-ns': 'not-owned', 'already-gone': 'absent',
    platform: 'reserved', 'kube-system': 'reserved',
  });
  expect(mockCore.deleteNamespace).toHaveBeenCalledTimes(1);
  expect(mockCore.deleteNamespace).toHaveBeenCalledWith({ name: 'shop-prod-1' });
});

it('deletes Argo CD Applications that target the project namespaces, with the cascade finalizer', async () => {
  mockCustom.listNamespacedCustomObject.mockResolvedValue({ items: [
    { metadata: { name: 'shop-prod-1' }, spec: { destination: { namespace: 'shop-prod-1' } } },
    { metadata: { name: 'shop-staging' }, spec: { destination: { namespace: 'shop-staging' } } },
    { metadata: { name: 'unrelated' }, spec: { destination: { namespace: 'other' } } },
    { metadata: { name: 'old-app' }, spec: { destination: { namespace: 'already-gone' } } },
  ] });
  const out = await removeArgoApplications(P, ['shop-prod-1', 'shop-staging', 'already-gone']);
  expect(out).toEqual({ 'shop-prod-1': 'deleted', 'shop-staging': 'not-owned', 'old-app': 'deleted' });
  const replaced = mockCustom.replaceNamespacedCustomObject.mock.calls.map((c: any) => c[0]);
  expect(replaced.map((r: any) => r.name)).toEqual(['shop-prod-1', 'old-app']);
  expect(replaced[0].body.metadata.finalizers).toContain('resources-finalizer.argocd.argoproj.io');
  expect(mockCustom.deleteNamespacedCustomObject.mock.calls.map((c: any) => c[0].name)).toEqual(['shop-prod-1', 'old-app']);
});

it('lists only id-derived MongoDB / Redis identities and never the platform Postgres database', async () => {
  const { id, env } = projectDbIdentity(P, 'production');
  mockSecrets.push(
    { environmentId: 'production', key: 'MONGO_DB', encryptedValue: `plat_${id}_${env}` },
    { environmentId: 'production', key: 'MONGO_USER', encryptedValue: `plat_${id}_${env}_user` },
    { environmentId: 'production', key: 'REDIS_USERNAME', encryptedValue: `plat_${id}_${env}` },
    { environmentId: 'production', key: 'REDIS_KEY_PREFIX', encryptedValue: `plat:${id}:${env}:` },
    // A legacy value pointing at a shared database is ignored.
    { environmentId: 'staging', key: 'MONGO_DB', encryptedValue: 'plat_platform' },
    { environmentId: 'staging', key: 'MONGO_USER', encryptedValue: 'admin' },
  );
  const dbs = await listProjectDatabases({
    id: P,
    databaseResources: {
      production: { dbName: `plat_${id}_${env}`, username: `plat_${id}_${env}_user` },
      staging: { dbName: 'plat_platform', username: 'postgres' },
    },
  } as any);
  expect(dbs.map((d) => `${d.kind}:${d.environment}:${d.name}`).sort()).toEqual([
    `mongo:production:plat_${id}_${env}`, `postgres:production:plat_${id}_${env}`, `redis:production:plat_${id}_${env}`,
  ].sort());
  expect(dbs.find((d) => d.kind === 'redis')!.keyPrefix).toBe(`plat:${id}:${env}:`);
});
