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

  it('clears nodes and pods for disconnected and empty responses', async () => {
    for (const k8sConnected of [false, true]) {
      component.nodes = [{ name: 'old-node' }];
      component.pods = [{ name: 'old-pod' }];
      api.getNodes.and.returnValue(of({ k8sConnected, nodes: k8sConnected ? [] : component.nodes }));
      api.getPods.and.returnValue(of({ k8sConnected, pods: k8sConnected ? [] : component.pods }));
      await component.loadNodes();
      await component.loadPods();
      expect(component.nodes).toEqual([]);
      expect(component.pods).toEqual([]);
      expect(component.k8sConnected).toBe(k8sConnected);
    }
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
