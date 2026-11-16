jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../../src/lib/operations', () => ({ defineOperation: (definition: any) => definition }));
jest.mock('../../../src/lib/release-workloads', () => ({ injectRelease: jest.fn() }));
jest.mock('../../../src/lib/autoscaling-k8s', () => ({ applyEnvironmentAutoscaling: jest.fn() }));
jest.mock('../../../src/lib/k8s', () => ({}));
import { getDb } from '../../../src/config/database';
import { applyEnvironmentAutoscaling } from '../../../src/lib/autoscaling-k8s';
import { deployOperation } from '../../../src/lib/deploy-op';
import { defaultAutoscaling } from '../../../src/lib/autoscaling';

it.each(['production', 'preview'])('reapplies saved autoscaling before finalizing a %s deployment', async name => {
  const env = { id: 'env', namespace: 'project-env', name, autoscaling: { ...defaultAutoscaling, enabled: true } };
  const save = jest.fn();
  const dep = { id: 'dep', projectId: 'project', environmentId: 'env', metadata: {}, version: '1.0.0' };
  (getDb as jest.Mock).mockResolvedValue({ getRepository: (entity: any) => ({ findOne: async () => entity.name === 'Environment' ? env : entity.name === 'Project' ? { id: 'project' } : dep, save }) });
  (applyEnvironmentAutoscaling as jest.Mock).mockResolvedValue(undefined);
  const ctx: any = { state: { deploymentId: 'dep', preview: name === 'preview' }, emit: jest.fn() };
  await deployOperation.steps.find(s => s.name === 'finalize')!.run(ctx);
  expect(applyEnvironmentAutoscaling).toHaveBeenLastCalledWith(env, env.autoscaling);
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: 'deployed' }));
  (applyEnvironmentAutoscaling as jest.Mock).mockRejectedValueOnce(new Error('Quota exceeded'));
  save.mockClear();
  await expect(deployOperation.steps.find(s => s.name === 'finalize')!.run(ctx)).rejects.toThrow('Quota exceeded');
  expect(save).not.toHaveBeenCalled();
});
