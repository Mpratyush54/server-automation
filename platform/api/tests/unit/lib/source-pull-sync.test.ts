const mockKid = jest.fn(async () => 'kid-1');
const mockApply = jest.fn(async (..._a: any[]) => undefined);
const mockEnvs = [
  { id: 'e1', projectId: 'p1', namespace: 'p1-staging', isActive: true, sourceImage: 'registry.example/p-p1/e-e1@sha256:1' },
  { id: 'e2', projectId: 'p2', namespace: 'p2-staging', isActive: true, sourceImage: 'registry.example/p-p2/e-e2@sha256:2' },
];
jest.mock('../../../src/lib/registry-token', () => ({ registrySignerKid: () => mockKid() }));
jest.mock('../../../src/lib/source-deploy', () => ({ applySourcePullSecret: (...a: any[]) => mockApply(...a) }));
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: (e: any) => ({
  find: async () => (e.name === 'Environment' ? mockEnvs : [{ id: 'p1' }]),
}) }) }));
import { resetSourcePullSyncForTests, syncSourcePullSecrets } from '../../../src/lib/source-pull-sync';

beforeEach(() => { jest.clearAllMocks(); resetSourcePullSyncForTests(); mockKid.mockResolvedValue('kid-1'); });

it('rewrites pull Secrets for active projects once per signing key', async () => {
  expect(await syncSourcePullSecrets()).toEqual({ written: 1, failed: 0 });
  expect(mockApply).toHaveBeenCalledWith('p1-staging', 'p1');
  expect(mockApply).not.toHaveBeenCalledWith('p2-staging', 'p2');
  expect(await syncSourcePullSecrets()).toEqual({ written: 0, failed: 0 });
  mockKid.mockResolvedValue('kid-2');
  expect(await syncSourcePullSecrets()).toEqual({ written: 1, failed: 0 });
  expect(mockApply).toHaveBeenCalledTimes(2);
});

it('retries on the next run when a Secret could not be written', async () => {
  mockApply.mockRejectedValueOnce(new Error('forbidden'));
  expect(await syncSourcePullSecrets()).toEqual({ written: 0, failed: 1 });
  expect(await syncSourcePullSecrets()).toEqual({ written: 1, failed: 0 });
});
