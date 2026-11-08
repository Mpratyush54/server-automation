const deployments = new Map<string, any>();
let orphanQuery: { wheres: string[] } = { wheres: [] };

const mockDeployRepo = {
  findOne: jest.fn(async ({ where }: any) => (deployments.has(where.id) ? { ...deployments.get(where.id) } : null)),
  save: jest.fn(async (d: any) => { deployments.set(d.id, { ...d }); return d; }),
  createQueryBuilder: jest.fn(() => {
    const qb: any = {
      where: (w: string) => { orphanQuery.wheres.push(w); return qb; },
      andWhere: (w: string) => { orphanQuery.wheres.push(w); return qb; },
      getMany: async () => [...deployments.values()].filter((d) => d.orphan).map((d) => ({ ...d })),
    };
    return qb;
  }),
};

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: () => mockDeployRepo })),
}));
jest.mock('../../../src/lib/k8s', () => ({}));
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: class {}, CoreV1Api: class {}, CustomObjectsApi: class {} }));

import {
  deployJobHandler, failOrphanedDeployments, isTerminalDeploymentStatus, markFailed,
} from '../../../src/lib/deploy-pipeline';
import { DeploymentStatus } from '../../../src/entities/Deployment';

describe('deploy pipeline recovery', () => {
  beforeEach(() => {
    deployments.clear();
    orphanQuery = { wheres: [] };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('classifies terminal states', () => {
    expect(isTerminalDeploymentStatus(DeploymentStatus.PENDING)).toBe(false);
    expect(isTerminalDeploymentStatus(DeploymentStatus.BUILDING)).toBe(false);
    expect(isTerminalDeploymentStatus(DeploymentStatus.DEPLOYING)).toBe(false);
    expect(isTerminalDeploymentStatus(DeploymentStatus.DEPLOYED)).toBe(true);
    expect(isTerminalDeploymentStatus(DeploymentStatus.FAILED)).toBe(true);
  });

  it('give-up marks an in-progress deployment failed with the reason', async () => {
    deployments.set('d1', { id: 'd1', status: DeploymentStatus.DEPLOYING, metadata: { gitPath: 'k8s' } });
    await deployJobHandler.onGiveUp({ targetId: 'd1' } as any, 'interrupted: API restarted');
    expect(deployments.get('d1').status).toBe(DeploymentStatus.FAILED);
    expect(deployments.get('d1').metadata).toEqual({ gitPath: 'k8s', error: 'interrupted: API restarted' });
  });

  it('never overwrites a terminal deployment', async () => {
    deployments.set('d1', { id: 'd1', status: DeploymentStatus.DEPLOYED, metadata: null });
    await markFailed('d1', 'late failure');
    expect(deployments.get('d1').status).toBe(DeploymentStatus.DEPLOYED);
  });

  it('isComplete reflects the deployment state (resume skips finished rollouts)', async () => {
    deployments.set('d1', { id: 'd1', status: DeploymentStatus.BUILDING });
    expect(await deployJobHandler.isComplete!({ targetId: 'd1' } as any)).toBe(false);
    deployments.set('d1', { id: 'd1', status: DeploymentStatus.FAILED });
    expect(await deployJobHandler.isComplete!({ targetId: 'd1' } as any)).toBe(true);
    expect(await deployJobHandler.isComplete!({ targetId: 'missing' } as any)).toBe(true);
  });

  it('fails orphaned POST /deploy rollouts that have no job row', async () => {
    deployments.set('d1', { id: 'd1', status: DeploymentStatus.BUILDING, metadata: { pullFromGit: true }, orphan: true });
    deployments.set('d2', { id: 'd2', status: DeploymentStatus.BUILDING, metadata: { pullFromGit: true } });
    expect(await failOrphanedDeployments()).toBe(1);
    expect(deployments.get('d1').status).toBe(DeploymentStatus.FAILED);
    expect(deployments.get('d2').status).toBe(DeploymentStatus.BUILDING);
    const sql = orphanQuery.wheres.join(' ');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM background_jobs');
    expect(sql).toContain(`'pullFromGit'`);
  });
});
