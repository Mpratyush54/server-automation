import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { PrivacyTabComponent } from './privacy-tab.component';
import { ApiService } from '../../../services/api.service';

const SETTINGS = {
  projectId: 'p1',
  scrubIps: true,
  scrubRules: [{ id: 'order', pattern: 'ORD-[0-9]+', replacement: '[ORDER]', flags: 'gi', enabled: true }],
  builtinScrubRules: [
    { id: 'email', name: 'Email addresses', replacement: '[EMAIL]', enabled: true },
    { id: 'ipv4', name: 'IPv4 addresses', replacement: '[IP]', enabled: true },
  ],
  retentionDays: { logs: 30, traces: 14, profiles: 14, replays: 7, errors: 90, heatmaps: 90 },
  retentionOverrides: { errors: 60 },
  consentDefaults: { replay: false, analytics: true },
  defaults: { retentionDays: { logs: 30, traces: 14, profiles: 14, replays: 7, errors: 90, heatmaps: 90 } },
};

describe('PrivacyTabComponent', () => {
  let api: jasmine.SpyObj<ApiService>;

  async function render() {
    const f = TestBed.createComponent(PrivacyTabComponent);
    f.componentRef.setInput('projectId', 'p1');
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    return f;
  }

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', [
      'getProjectPrivacy', 'updateProjectPrivacyScrubbing', 'updateProjectPrivacyRetention',
      'updateProjectPrivacyConsentDefaults', 'gdprDelete',
    ]);
    api.getProjectPrivacy.and.returnValue(of(SETTINGS));
    api.updateProjectPrivacyScrubbing.and.returnValue(of(SETTINGS));
    api.updateProjectPrivacyRetention.and.returnValue(of(SETTINGS));
    api.updateProjectPrivacyConsentDefaults.and.returnValue(of(SETTINGS));
    await TestBed.configureTestingModule({
      imports: [PrivacyTabComponent],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  it('renders the four panels with plain copy', async () => {
    const f = await render();
    const el: HTMLElement = f.nativeElement;
    for (const id of ['scrubbing', 'retention', 'consent', 'gdpr']) {
      expect(el.querySelector(`[data-testid="privacy-${id}"] .card-header`)).withContext(id).not.toBeNull();
    }
    const scrub = el.querySelector('[data-testid="privacy-scrubbing"]')!.textContent!;
    expect(scrub).toContain('Email addresses');
    expect(scrub).toContain('[EMAIL]');
    const retention = el.querySelector('[data-testid="privacy-retention"]')!.textContent!;
    expect(retention).toContain('Default: 30 days');
    expect(retention).toContain('Cluster setting: 14 days');
    expect(el.querySelectorAll('[data-testid="privacy-retention"] input').length).toBe(4);
    expect(el.querySelectorAll('input[role="switch"]').length).toBe(2);
    // Internal component names stay inside the "What gets deleted" disclosure.
    const gdprMain = el.querySelector('[data-testid="privacy-gdpr"]')!.cloneNode(true) as HTMLElement;
    gdprMain.querySelectorAll('details').forEach((d) => d.remove());
    expect(gdprMain.textContent).not.toMatch(/Mongo|MinIO|Loki|Alloy/);
  });

  it('save buttons send the same requests as before', async () => {
    const f = await render();
    const buttons = Array.from(f.nativeElement.querySelectorAll('.pv-footer button')) as HTMLButtonElement[];
    const byText = (t: string) => buttons.find((b) => b.textContent!.includes(t))!;
    byText('Save scrubbing').click();
    await f.whenStable();
    expect(api.updateProjectPrivacyScrubbing).toHaveBeenCalledWith('p1', {
      scrubIps: true,
      rules: [jasmine.objectContaining({ id: 'order', pattern: 'ORD-[0-9]+' })],
    });
    byText('Save retention').click();
    await f.whenStable();
    expect(api.updateProjectPrivacyRetention).toHaveBeenCalledWith('p1', { logs: null, replays: null, errors: 60, heatmaps: null });
    byText('Save consent defaults').click();
    await f.whenStable();
    f.detectChanges();
    expect(api.updateProjectPrivacyConsentDefaults).toHaveBeenCalledWith('p1', { replay: false, analytics: true });
    expect(f.nativeElement.querySelector('[data-testid="privacy-consent"]').textContent).toContain('Consent defaults saved');
  });

  it('GDPR delete asks for confirmation first', async () => {
    const f = await render();
    f.componentInstance.gdpr.userId = 'u1';
    spyOn(window, 'confirm').and.returnValue(false);
    await f.componentInstance.runGdprDelete();
    expect(window.confirm).toHaveBeenCalled();
    expect(api.gdprDelete).not.toHaveBeenCalled();
  });
});
