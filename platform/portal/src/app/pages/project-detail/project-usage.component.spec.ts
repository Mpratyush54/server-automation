import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ProjectUsageComponent } from './project-usage.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

describe('ProjectUsageComponent', () => {
  let fixture: ComponentFixture<ProjectUsageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectUsageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ApiService,
          useValue: {
            getProjectUsage: () => of({
              currency: 'USD',
              from: '2026-03-01',
              to: '2026-03-15',
              totals: { cpuCoreHours: 12, memoryGbHours: 40, pvcStorageGb: 2, objectStorageGb: 1, ingressBandwidthGb: 0.5, buildMinutes: 8 },
              cost: { total: 1.25 },
              daily: [{ day: '2026-03-01', metrics: { cpuCoreHours: 4 } }, { day: '2026-03-02', metrics: { cpuCoreHours: 8 } }],
              quota: { cpuCoreHours: 100 },
              quotaBars: {
                cpuCoreHours: { used: 12, limit: 100, percent: 12 },
                memoryGbHours: { used: 40, limit: null, percent: null },
                storageGb: { used: 3, limit: null, percent: null },
                bandwidthGb: { used: 0.5, limit: null, percent: null },
                buildMinutes: { used: 8, limit: null, percent: null },
              },
            }),
            updateProjectUsageQuota: () => of({}),
            exportProjectUsageCsv: () => of(new Blob(['day\n'])),
          },
        },
        { provide: AuthService, useValue: { isTechLeadOrDevOps: () => true } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectUsageComponent);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('shows this month cost, chart and quota bars', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="project-usage"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="usage-cost"]')!.textContent).toContain('1.25');
    expect(el.querySelectorAll('.usage-day').length).toBe(2);
    expect(el.textContent).toContain('core-hours');
    expect(el.querySelector('progress.quota')).toBeTruthy();
  });
});
