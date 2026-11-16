import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ProjectDetailComponent } from './project-detail.component';

describe('Project pod data', () => {
  let api: jasmine.SpyObj<ApiService>;
  let component: ProjectDetailComponent;

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['getPods']);
    TestBed.configureTestingModule({ providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: {} },
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: {} },
    ] });
    component = TestBed.runInInjectionContext(() => new ProjectDetailComponent(
      TestBed.inject(ActivatedRoute), TestBed.inject(ApiService), TestBed.inject(AuthService)
    ));
    component.project = { name: 'shop' };
  });

  it('clears stale pods for disconnected and empty responses', async () => {
    for (const k8sConnected of [false, true]) {
      component.pods = [{ name: 'shop-api', namespace: 'shop' }];
      api.getPods.and.returnValue(of({ k8sConnected, pods: k8sConnected ? [] : component.pods }));
      await component.loadK8sPods();
      expect(component.pods).toEqual([]);
      expect(component.k8sConnected).toBe(k8sConnected);
    }
  });

  it('filters connected pods to the project', async () => {
    const pod = { name: 'shop-api', namespace: 'shop' };
    api.getPods.and.returnValue(of({ k8sConnected: true, pods: [pod, { name: 'other', namespace: 'other' }] }));
    await component.loadK8sPods();
    expect(component.pods).toEqual([pod]);
  });

  it('clears stale pods when the request fails', async () => {
    component.pods = [{ name: 'shop-api', namespace: 'shop' }];
    component.k8sConnected = true;
    api.getPods.and.returnValue(throwError(() => new Error('Unavailable')));
    await component.loadK8sPods();
    expect(component.pods).toEqual([]);
    expect(component.k8sConnected).toBeFalse();
  });
});
