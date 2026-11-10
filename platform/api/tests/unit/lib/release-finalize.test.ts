const mockDeployRepo={findOne:jest.fn(),save:jest.fn(),update:jest.fn()};
const mockProjectRepo={findOne:jest.fn(async()=>({id:'p',name:'app'}))};
const mockEnvRepo={findOne:jest.fn(async()=>({id:'env',namespace:'ns',name:'production'}))};
jest.mock('../../../src/config/database',()=>({getDb:async()=>({getRepository:(e:any)=>e.name==='Deployment'?mockDeployRepo:e.name==='Project'?mockProjectRepo:mockEnvRepo})}));
jest.mock('../../../src/lib/operations',()=>({defineOperation:(def:any)=>def}));
jest.mock('../../../src/lib/k8s',()=>({}));
jest.mock('../../../src/lib/release-workloads',()=>({injectRelease:jest.fn()}));
jest.mock('../../../src/lib/namespace-backfill',()=>({}));
jest.mock('../../../src/lib/namespace-baseline',()=>({}));
jest.mock('@kubernetes/client-node',()=>({}));
import { deployOperation } from '../../../src/lib/deploy-op';
import { injectRelease } from '../../../src/lib/release-workloads';
const context=()=>({state:{deploymentId:'rollback'},operationId:'op',emit:jest.fn()} as any);
beforeEach(()=>{jest.clearAllMocks();mockDeployRepo.findOne.mockResolvedValue({id:'rollback',projectId:'p',environmentId:'env',version:'v1',imageTag:'v1',commitSha:'111',status:'deploying',metadata:{rollbackFrom:'current'}});});
it('marks the original rolled back only after successful restored rollout and emits a fresh marker',async()=>{
 const ctx=context();await deployOperation.steps.find(s=>s.name==='finalize')!.run(ctx);
 expect(injectRelease).toHaveBeenCalledWith('ns','p','111');
 expect(mockDeployRepo.update).toHaveBeenCalledWith('current',expect.objectContaining({status:'rolled_back'}));
 expect(ctx.emit).toHaveBeenCalledWith('deploy.marker',{deploymentId:'rollback'});
});
it('never claims restoration or emits a marker if the injected rollout fails',async()=>{
 (injectRelease as jest.Mock).mockRejectedValueOnce(new Error('rollout timeout'));
 const ctx=context();await expect(deployOperation.steps.find(s=>s.name==='finalize')!.run(ctx)).rejects.toThrow('rollout timeout');
 expect(mockDeployRepo.update).not.toHaveBeenCalled();expect(mockDeployRepo.save).not.toHaveBeenCalled();expect(ctx.emit).not.toHaveBeenCalled();
});
it('preserves the durable three-step layout for pre-upgrade resumable deployments',()=>{
 expect(deployOperation.steps.map(s=>s.name)).toEqual(['apply','wait-healthy','finalize']);
});
