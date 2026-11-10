jest.mock('../../src/config/database', () => ({ getDb: jest.fn(async () => ({ getRepository: () => repo })) }));
jest.mock('../../src/lib/argocd', () => ({ argoResource: { namespace: 'argocd' }, argoClient: () => client }));
jest.mock('../../src/lib/k8s', () => ({ argoAppName: () => 'fallback' }));
jest.mock('../../src/lib/leader', () => ({ getLeadership: () => ({ isLeader: () => leader }) }));
jest.mock('../../src/lib/git-default-branch', () => ({ repositoryHasBranch: jest.fn(), resolveDefaultBranch: jest.fn() }));
jest.mock('../../src/middleware/auth', () => ({ logAudit: jest.fn() }));
import { repairArgoDefaultBranches } from '../../src/lib/argocd-branch-repair';
import { repositoryHasBranch, resolveDefaultBranch } from '../../src/lib/git-default-branch';
import { logAudit } from '../../src/middleware/auth';
const repo = { find: jest.fn(), update: jest.fn() };
const client = { getNamespacedCustomObject: jest.fn(), patchNamespacedCustomObject: jest.fn() };
let leader = true;
let app: any;
let project: any;
beforeEach(() => {
  jest.clearAllMocks(); leader = true;
  project = { id: 'p', repositoryUrl: 'https://github.com/org/repo', environments: [{ namespace: 'owned-dev' }] };
  app = { metadata: { resourceVersion: '4' }, spec: { source: { repoURL: project.repositoryUrl, targetRevision: 'main' } } };
  repo.find.mockResolvedValue([project]);
  client.getNamespacedCustomObject.mockImplementation(async () => app);
  client.patchNamespacedCustomObject.mockImplementation(async ({ body }: any) => { app.spec.source.targetRevision = body[2].value; });
  (repositoryHasBranch as jest.Mock).mockResolvedValue(false);
  (resolveDefaultBranch as jest.Mock).mockResolvedValue('master');
});
it('repairs main to the confirmed default and is idempotent on subsequent runs', async () => {
  await repairArgoDefaultBranches(); await repairArgoDefaultBranches();
  expect(client.patchNamespacedCustomObject).toHaveBeenCalledTimes(1);
  expect(client.patchNamespacedCustomObject.mock.calls[0][0]).toMatchObject({ name: 'owned-dev', body: [
    { op: 'test', path: '/metadata/resourceVersion', value: '4' },
    { op: 'test', path: '/spec/source/targetRevision', value: 'main' },
    { op: 'replace', path: '/spec/source/targetRevision', value: 'master' },
  ] });
  expect(repo.update).toHaveBeenCalledWith({ id: 'p', repositoryUrl: project.repositoryUrl }, { defaultBranch: 'master' });
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'argocd.branch_repaired' }));
});
it.each([true, undefined])('leaves main unchanged unless absence is confirmed (%s)', async exists => {
  (repositoryHasBranch as jest.Mock).mockResolvedValue(exists);
  await repairArgoDefaultBranches(); expect(client.patchNamespacedCustomObject).not.toHaveBeenCalled();
});
it('does not run on a follower or after losing leadership during lookup', async () => {
  leader = false; await repairArgoDefaultBranches(); expect(client.getNamespacedCustomObject).not.toHaveBeenCalled();
  leader = true; (resolveDefaultBranch as jest.Mock).mockImplementationOnce(async () => { leader = false; return 'master'; });
  await repairArgoDefaultBranches(); expect(client.patchNamespacedCustomObject).not.toHaveBeenCalled();
});
it('preserves explicit project overrides, other refs and multi-source applications', async () => {
  project.gitRevision = 'main'; await repairArgoDefaultBranches();
  project.gitRevision = null; app.spec.source.targetRevision = 'stable'; await repairArgoDefaultBranches();
  app.spec.source.targetRevision = 'main'; app.spec.sources = []; await repairArgoDefaultBranches();
  expect(client.patchNamespacedCustomObject).not.toHaveBeenCalled();
});
it('does not migrate on discovery failure', async () => {
  (resolveDefaultBranch as jest.Mock).mockResolvedValue('HEAD');
  await repairArgoDefaultBranches(); expect(client.patchNamespacedCustomObject).not.toHaveBeenCalled();
});
