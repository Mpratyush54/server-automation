import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { LicenseSettingsComponent, ENTERPRISE_QUOTE_URL, MANAGE_LICENSE_URL } from './license-settings.component';
import { ApiService } from '../../services/api.service';

describe('LicenseSettingsComponent', () => {
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['getLicense']);
    await TestBed.configureTestingModule({
      imports: [LicenseSettingsComponent],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  async function render() {
    const f = TestBed.createComponent(LicenseSettingsComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('shows plan, limits and a status badge', async () => {
    api.getLicense.and.returnValue(of({
      available: true, status: 'valid', state: 'valid', plan: 'personal', org: null, maxNodes: 3, maxInstalls: 2,
      expiresAt: '2027-01-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', enforce: false,
    }));
    const el = await render();
    const badge = el.querySelector('[data-testid="license-badge"]')!;
    expect(badge.classList).toContain('status-ok');
    expect(badge.textContent).toContain('Valid');
    expect(el.textContent).toContain('Personal');
    expect(el.textContent).toContain('Up to 3 nodes, 2 installs');
    const links = Array.from(el.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(links).toEqual([MANAGE_LICENSE_URL, ENTERPRISE_QUOTE_URL]);
  });

  it('uses warn and down badges', async () => {
    api.getLicense.and.returnValue(of({ available: true, state: 'attention' }));
    let el = await render();
    expect(el.querySelector('[data-testid="license-badge"]')!.classList).toContain('status-warn');
    api.getLicense.and.returnValue(of({ available: true, state: 'invalid' }));
    el = await render();
    expect(el.querySelector('[data-testid="license-badge"]')!.classList).toContain('status-down');
  });

  it('explains when there is no license yet', async () => {
    api.getLicense.and.returnValue(of({ available: false, state: 'unknown' }));
    const el = await render();
    expect(el.querySelector('[data-testid="license-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="license-badge"]')).toBeNull();
  });

  it('shows load errors', async () => {
    api.getLicense.and.returnValue(throwError(() => ({ error: { error: 'Forbidden' } })));
    const el = await render();
    expect(el.textContent).toContain('Forbidden');
  });
});
