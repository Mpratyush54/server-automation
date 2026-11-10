import express from 'express';
import request from 'supertest';
const mockRepo = { findOne: jest.fn(), save: jest.fn(async d => ({id:'rollback',...d})), create: jest.fn(d=>d) };
const mockEnvRepo = { findOne: jest.fn(async () => ({id:'env',projectId:'p',name:'production'})) };
jest.mock('../../../src/config/database', () => ({getDb: async () => ({getRepository: (e: any) => e.name === 'Deployment' ? mockRepo : mockEnvRepo})}));
jest.mock('../../../src/middleware/auth', () => ({expressAuthenticate:(req:any,_res:any,next:any)=>{req.user={id:'user'};next();},expressRequireRole:()=> (_req:any,_res:any,next:any)=>next(),logAudit:jest.fn()}));
jest.mock('../../../src/lib/project-access', () => ({requireProjectAccess:jest.fn(async()=>({ok:true}))}));
jest.mock('../../../src/lib/project-revision', () => ({projectRevision:jest.fn()}));
jest.mock('../../../src/lib/k8s', () => ({}));
jest.mock('../../../src/lib/deploy-op', () => ({DEPLOY_OPERATION:'deployment.deploy'}));
jest.mock('../../../src/lib/operations', () => ({newOperationId:()=> 'operation',createOperation:jest.fn(),runOperation:jest.fn(async()=>({}))}));
jest.mock('../../../src/lib/locks', () => ({projectLockKey:()=> 'lock',acquireLock:jest.fn(async()=>({release:jest.fn()})),getLockHolder:jest.fn(),LockBusyError:class extends Error {}}));
jest.mock('../../../src/middleware/idempotency',()=>({idempotency:()=> (_req:any,_res:any,next:any)=>next()}));
import router from '../../../src/routes/deployments';
import { createOperation } from '../../../src/lib/operations';
import { requireProjectAccess } from '../../../src/lib/project-access';
const app=express();app.use(express.json(),router);
const current={id:'current',projectId:'p',environmentId:'env',status:'deployed',version:'v2',imageTag:'v2',commitSha:'222',createdAt:new Date()};
const prior={...current,id:'prior',version:'v1',imageTag:'v1',commitSha:'111',branch:'main',metadata:{gitPath:'k8s',grafanaAnnotationId:123}};
beforeEach(()=>{jest.clearAllMocks();(requireProjectAccess as jest.Mock).mockResolvedValue({ok:true});});
it('restores the previous image and SHA using the durable deploy operation',async()=>{
 mockRepo.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce(current).mockResolvedValueOnce(prior);
 const result=await request(app).post('/rollback').send({deploymentId:'current',reason:'Latency regression'});
 expect(result.status).toBe(201);
 expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({imageTag:'v1',commitSha:'111',status:'pending',metadata:expect.objectContaining({rollbackFrom:'current',rollbackReason:'Latency regression'})}));
 expect(createOperation).toHaveBeenCalledWith('deployment.deploy',expect.objectContaining({lockKey:'lock',state:{deploymentId:'rollback'}}));
 expect(mockRepo.create.mock.calls[0][0].metadata.grafanaAnnotationId).toBeUndefined();
 expect(mockRepo.save).not.toHaveBeenCalledWith(expect.objectContaining({id:'current',status:'rolled_back'}));
});
it('rejects stale actions instead of rolling back a newer release',async()=>{
 mockRepo.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce({...current,id:'newer'});
 expect((await request(app).post('/rollback').send({deploymentId:'current',reason:'Restore'})).status).toBe(409);
 expect(createOperation).not.toHaveBeenCalled();
});
it('requires a recorded reason',async()=>{
 mockRepo.findOne.mockResolvedValue(current);
 expect((await request(app).post('/rollback').send({deploymentId:'current'})).status).toBe(400);
});
it('enforces project access',async()=>{
 mockRepo.findOne.mockResolvedValue(current);(requireProjectAccess as jest.Mock).mockResolvedValue({ok:false,status:403,error:'Forbidden'});
 expect((await request(app).post('/rollback').send({deploymentId:'current',reason:'Restore'})).status).toBe(403);
 expect(createOperation).not.toHaveBeenCalled();
});

it('does not create a deployment when there is no prior successful target',async()=>{
 mockRepo.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce(current).mockResolvedValueOnce(null);
 expect((await request(app).post('/rollback').send({deploymentId:'current',reason:'Restore'})).status).toBe(409);
 expect(createOperation).not.toHaveBeenCalled();
});
