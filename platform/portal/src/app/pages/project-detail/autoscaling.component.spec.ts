import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AutoscalingComponent } from './autoscaling.component';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../shared/feedback/feedback.service';

describe('Environment autoscaling', () => {
  const result = { settings: { enabled: true, minReplicas: 1, maxReplicas: 3, targetCpuPercent: 70 }, capabilities: { rps: false, scaleToZero: false }, workloads: [{ name: 'web', currentReplicas: 2, readyReplicas: 1, hpa: { conditions: [{ type: 'ScalingActive', status: 'True', reason: 'ValidMetricFound' }] } }] };
  let api: any;
  let toast: any;
  beforeEach(async () => {
    api = { getEnvironmentAutoscaling: jasmine.createSpy().and.returnValue(of(result)), putEnvironmentAutoscaling: jasmine.createSpy().and.returnValue(of(result)) };
    toast = { ok: jasmine.createSpy(), error: jasmine.createSpy() };
    await TestBed.configureTestingModule({ imports: [AutoscalingComponent], providers: [{ provide: ApiService, useValue: api }, { provide: ToastService, useValue: toast }] }).compileComponents();
  });
  async function render(edit = true) {
    const f = TestBed.createComponent(AutoscalingComponent);
    f.componentRef.setInput('projectId', 'project');
    f.componentRef.setInput('environmentId', 'env');
    f.componentRef.setInput('canEdit', edit);
    f.detectChanges(); await f.whenStable(); f.detectChanges();
    return f;
  }
  it('shows live replicas and status, with unavailable RPS disabled and explained', async () => {
    const f = await render();
    expect(api.getEnvironmentAutoscaling).toHaveBeenCalledWith('project', 'env');
    expect(f.nativeElement.textContent).toContain('2 replicas, 1 ready');
    expect(f.nativeElement.querySelector('.status-ok').textContent).toBe('active');
    expect(f.nativeElement.querySelector('[name="targetRps"]').disabled).toBeTrue();
    expect(f.nativeElement.textContent).toContain('Request scaling needs the full profile');
    expect(f.nativeElement.querySelectorAll('button[type="submit"]').length).toBe(1);
  });
  it('saves cleared optional targets without null values', async () => {
    const f = await render();
    f.componentInstance.settings.targetCpuPercent = null;
    f.componentInstance.settings.targetRps = 20;
    await f.componentInstance.save();
    expect(api.putEnvironmentAutoscaling).toHaveBeenCalledWith('project', 'env', { enabled: true, minReplicas: 1, maxReplicas: 3, targetRps: 20 });
    expect(toast.ok).toHaveBeenCalled();
  });
  it('makes controls read-only for viewers', async () => {
    const f = await render(false);
    expect(f.nativeElement.querySelector('input[type="checkbox"]').disabled).toBeTrue();
    expect(f.nativeElement.querySelector('fieldset').disabled).toBeTrue();
    expect(f.nativeElement.querySelector('button[type="submit"]')).toBeNull();
    await f.componentInstance.save();
    expect(api.putEnvironmentAutoscaling).not.toHaveBeenCalled();
  });
  it('allows preview zero only when HTTP activation is available', async () => {
    const f = await render();
    f.componentRef.setInput('preview', true);
    f.detectChanges(); await f.whenStable();
    f.componentInstance.capabilities = { rps: true, scaleToZero: true };
    f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(f.nativeElement.querySelector('[name="minReplicas"]').min).toBe('0');
    expect(f.nativeElement.querySelector('[name="targetRps"]').disabled).toBeFalse();
    expect(f.nativeElement.textContent).toContain('60 seconds');
  });
  it('keeps edited settings and reports a rejected save', async () => {
    const f = await render();
    api.putEnvironmentAutoscaling.and.returnValue(throwError(() => ({ error: { error: 'maxReplicas exceeds ResourceQuota pods' } })));
    f.componentInstance.settings.maxReplicas = 10;
    await f.componentInstance.save(); f.detectChanges();
    expect(f.nativeElement.querySelector('[role="alert"]').textContent).toContain('ResourceQuota');
    expect(f.componentInstance.settings.maxReplicas).toBe(10);
    expect(f.componentInstance.saving).toBeFalse();
    expect(toast.error).toHaveBeenCalled();
  });
});
