import axios from 'axios';
const mockRepo={findOneByOrFail:jest.fn(),update:jest.fn()};
jest.mock('axios',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
jest.mock('../../../src/config/database',()=>({getDb:async()=>({getRepository:()=>mockRepo})}));
jest.mock('../../../src/lib/alert-events',()=>({publishAlertEvent:jest.fn()}));
import { publishReleaseMarker } from '../../../src/lib/release-markers';
import { publishAlertEvent } from '../../../src/lib/alert-events';
const dep={id:'d',projectId:'p',environmentId:'env',commitSha:'abc',imageTag:'v2',deployedById:'author',deployedAt:new Date('2026-01-01T00:00:00Z'),metadata:{}};
beforeEach(()=>{jest.clearAllMocks();mockRepo.findOneByOrFail.mockResolvedValue({...dep});process.env.GRAFANA_URL='http://grafana.test';process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN='test-only';});
afterEach(()=>{delete process.env.GRAFANA_URL;delete process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;});
it('creates a timestamped project annotation and a shared deploy event',async()=>{
 (axios.get as jest.Mock).mockResolvedValue({data:[]});(axios.post as jest.Mock).mockResolvedValue({data:{id:123}});
 await publishReleaseMarker('d');
 expect(axios.post).toHaveBeenCalledWith('http://grafana.test/api/annotations',expect.objectContaining({time:dep.deployedAt.getTime(),tags:expect.arrayContaining(['project:p','deployment:d']),text:expect.stringContaining('commit abc; author author')}),expect.anything());
 expect(mockRepo.update).toHaveBeenCalledWith('d',{metadata:{grafanaAnnotationId:123}});
 expect(publishAlertEvent).toHaveBeenCalledWith(expect.objectContaining({source:'deploy',dedupeKey:'deploy:d'}));
});
it('recovers a prior annotation on retry instead of duplicating it',async()=>{
 (axios.get as jest.Mock).mockResolvedValue({data:[{id:123}]});await publishReleaseMarker('d');expect(axios.post).not.toHaveBeenCalled();
});
it('works without Grafana on a light install',async()=>{
 delete process.env.GRAFANA_URL;await publishReleaseMarker('d');expect(axios.post).not.toHaveBeenCalled();expect(publishAlertEvent).toHaveBeenCalled();
});
it('propagates Grafana outages to the retrying outbox',async()=>{
 (axios.get as jest.Mock).mockRejectedValue(new Error('unavailable'));await expect(publishReleaseMarker('d')).rejects.toThrow('unavailable');
});
