import { componentLabel } from './status-page-editor.component';
import { dayTitle, statusLabel } from './public-status.component';

describe('status page helpers (#46)', () => {
  it('prefers the statusPage display name for components', () => {
    expect(componentLabel({
      id: '1', name: 'API health', type: 'http', enabled: true,
      config: { statusPage: { name: 'API' } },
    })).toBe('API');
    expect(componentLabel({ id: '2', name: 'Checkout', type: 'browser', enabled: true })).toBe('Checkout');
  });

  it('labels overall and day statuses for the public page', () => {
    expect(statusLabel('operational')).toContain('operational');
    expect(statusLabel('major_outage')).toContain('Major');
    expect(dayTitle({ date: '2026-11-10', uptime: 99.5, status: 'degraded' })).toBe('2026-11-10: 99.5% (degraded)');
    expect(dayTitle({ date: '2026-11-09', uptime: null, status: 'unknown' })).toContain('no data');
  });
});
