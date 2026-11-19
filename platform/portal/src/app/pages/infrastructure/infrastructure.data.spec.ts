import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { InfrastructureComponent } from './infrastructure.component';

describe('Infrastructure cluster data', () => {
  let api: jasmine.SpyObj<ApiService>;
  let component: InfrastructureComponent;

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['getNodes', 'getPods', 'getBootstrapHistory']);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    component = TestBed.runInInjectionContext(() => new InfrastructureComponent(api));
  });

  it('takes an empty connected answer as empty, and never shows data from an unreachable cluster it never reached', async () => {
    api.getNodes.and.returnValue(of({ k8sConnected: false, nodes: [] }));
    api.getPods.and.returnValue(of({ k8sConnected: false, pods: [] }));
    expect(await component.loadNodes()).toBe('down');
    await component.loadPods();
    expect(component.nodes).toEqual([]);
    expect(component.pods).toEqual([]);
    expect(component.k8sConnected).toBeFalse();

    component.nodes = [{ name: 'old-node' }];
    component.pods = [{ name: 'old-pod' }];
    api.getNodes.and.returnValue(of({ k8sConnected: true, nodes: [] }));
    api.getPods.and.returnValue(of({ k8sConnected: true, pods: [] }));
    expect(await component.loadNodes()).toBe('ok');
    await component.loadPods();
    expect(component.nodes).toEqual([]);
    expect(component.pods).toEqual([]);
    expect(component.k8sConnected).toBeTrue();
  });

  it('keeps the last data for one disconnected answer after the cluster was reachable', async () => {
    api.getPods.and.returnValue(of({ k8sConnected: true, pods: [{ name: 'pod-1' }] }));
    await component.loadPods();
    api.getPods.and.returnValue(of({ k8sConnected: false, pods: [] }));
    await component.loadPods();
    expect(component.pods).toEqual([{ name: 'pod-1' }]);
    expect(component.k8sConnected).toBeTrue();
    expect(component.clusterReconnecting).toBeTrue();
  });

  it('keeps connected data and forwards the selected namespace', async () => {
    const nodes = [{ name: 'node-1' }];
    const pods = [{ name: 'pod-1' }];
    api.getNodes.and.returnValue(of({ k8sConnected: true, nodes }));
    api.getPods.and.returnValue(of({ k8sConnected: true, pods }));
    component.selectedNamespace = 'platform';
    await component.loadNodes();
    await component.loadPods();
    expect(component.nodes).toEqual(nodes);
    expect(component.pods).toEqual(pods);
    expect(api.getPods).toHaveBeenCalledWith('platform');
  });

  it('clears stale pods and connection state when the request fails', async () => {
    component.pods = [{ name: 'old-pod' }];
    component.k8sConnected = true;
    api.getPods.and.returnValue(throwError(() => new Error('Unavailable')));
    await component.loadPods();
    expect(component.pods).toEqual([]);
    expect(component.k8sConnected).toBeFalse();
  });

  it('accepts empty bootstrap history', async () => {
    component.bootstrapHistory = [{ hostname: 'old-node' }];
    api.getBootstrapHistory.and.returnValue(of([]));
    await component.loadBootstrapHistory();
    expect(component.bootstrapHistory).toEqual([]);
  });
});
