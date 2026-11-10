const mockCore = { readNamespace: jest.fn() };
const mockApps = { listNamespacedDeployment: jest.fn(),listNamespacedStatefulSet: jest.fn(),replaceNamespacedDeployment:jest.fn(),replaceNamespacedStatefulSet:jest.fn(),readNamespacedDeployment:jest.fn(),readNamespacedStatefulSet:jest.fn() };
jest.mock('@kubernetes/client-node',()=>({KubeConfig:class {makeApiClient(kind:any){return kind==='core'?mockCore:mockApps;}},CoreV1Api:'core',AppsV1Api:'apps'}));
jest.mock('../../../src/lib/kube-config',()=>({loadKubeConfig:jest.fn()}));
import { injectRelease } from '../../../src/lib/release-workloads';
const workload=()=>({metadata:{name:'app',generation:2,resourceVersion:'42'},spec:{replicas:1,template:{spec:{containers:[{name:'web',env:[{name:'TEAM',value:'ops'},{name:'OTEL_RESOURCE_ATTRIBUTES',value:'team=ops,service.version=old'}]}],initContainers:[{name:'setup'}]}}},status:{observedGeneration:2,updatedReplicas:1,readyReplicas:1}});
beforeEach(()=>{jest.clearAllMocks();mockCore.readNamespace.mockResolvedValue({metadata:{labels:{'platform.io/project':'p'}}});mockApps.listNamespacedDeployment.mockResolvedValue({items:[workload()]});mockApps.listNamespacedStatefulSet.mockResolvedValue({items:[workload()]});mockApps.readNamespacedDeployment.mockResolvedValue(workload());mockApps.readNamespacedStatefulSet.mockResolvedValue(workload());});
it('injects all containers, preserves unrelated env and uses resourceVersion for concurrency',async()=>{
 await injectRelease('namespace','p','v2');
 for(const fn of [mockApps.replaceNamespacedDeployment,mockApps.replaceNamespacedStatefulSet]) {
  const body=fn.mock.calls[0][0].body;
  expect(body.metadata.resourceVersion).toBe('42');
  expect(body.spec.template.spec.containers[0].env).toContainEqual({name:'TEAM',value:'ops'});
  expect(body.spec.template.spec.containers[0].env).toContainEqual({name:'OTEL_RESOURCE_ATTRIBUTES',value:'team=ops,service.version=v2'});
  expect(body.spec.template.spec.initContainers[0].env).toContainEqual({name:'PLATFORM_RELEASE',value:'v2'});
 }
});
it('never changes workloads in another project namespace',async()=>{
 mockCore.readNamespace.mockResolvedValue({metadata:{labels:{'platform.io/project':'other'}}});
 await expect(injectRelease('namespace','p','v2')).rejects.toThrow('ownership');
 expect(mockApps.replaceNamespacedDeployment).not.toHaveBeenCalled();
});
it('does not record an empty namespace as a release rollout',async()=>{
 mockApps.listNamespacedDeployment.mockResolvedValue({items:[]});mockApps.listNamespacedStatefulSet.mockResolvedValue({items:[]});
 await expect(injectRelease('namespace','p','v2')).rejects.toThrow('No supported');
});
