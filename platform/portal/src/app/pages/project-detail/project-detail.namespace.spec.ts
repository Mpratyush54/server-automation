import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

describe('Project namespace isolation status', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: {} },
        { provide: ApiService, useValue: {} },
        { provide: AuthService, useValue: {} },
      ],
    }).compileComponents();
  });
  function render(baseline: any) {
    const fixture = TestBed.createComponent(ProjectDetailComponent);
    spyOn(fixture.componentInstance, 'ngOnInit').and.stub();
    fixture.componentInstance.activeTab = 'isolation-only';
    fixture.componentInstance.project = { name: 'Example', namespaceBaselines: [baseline] };
    fixture.detectChanges();
    return fixture;
  }
  it('renders applied policies, PSA and resource usage', () => {
    const fixture = render({ namespace: 'example-prod', policyApplied: true, psa: 'restricted', ownerMatches: true, quotaApplied: true, limitsApplied: true, quota: { hard: { pods: '20' }, used: { pods: '2' } } });
    const section = fixture.nativeElement.querySelector('[aria-label="Namespace isolation"]');
    expect(section.textContent).toContain('Applied');
    expect(section.textContent).toContain('restricted');
    const cells = Array.from(section.querySelectorAll('tbody td')).map((td: any) => td.textContent.trim());
    expect(cells).toEqual(['pods', '2', '20']);
    fixture.destroy();
  });
  it('shows migration warnings, drift and unavailable status', () => {
    const fixture = render({ namespace: 'example-legacy', policyApplied: false, psa: 'privileged', ownerMatches: false, additionalPolicies: ['custom-allow'], error: 'Baseline status unavailable' });
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('warn/audit mode');
    expect(text).toContain('Missing or changed');
    expect(text).toContain('custom-allow');
    expect(text).toContain('ownership labels do not match');
    expect(text).toContain('Baseline status unavailable');
    fixture.destroy();
  });
});
