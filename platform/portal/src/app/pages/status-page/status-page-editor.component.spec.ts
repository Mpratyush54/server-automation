import { componentLabel, localInputToIso, phaseLabel, UPDATE_STATUSES } from './status-page-editor.component';
import { dayTitle, incidentPhase, statusLabel } from './public-status.component';

describe('status page maintenance + updates (#46)', () => {
  it('converts datetime-local values to ISO and rejects empty input', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('not a date')).toBeNull();
    const iso = localInputToIso('2026-11-10T14:30');
    expect(iso).toBe(new Date('2026-11-10T14:30').toISOString());
  });

  it('labels upcoming, in-progress and auto-completed maintenance', () => {
    expect(phaseLabel({ phase: 'upcoming', status: 'scheduled', isMaintenance: true })).toBe('upcoming');
    expect(phaseLabel({ phase: 'active', status: 'scheduled', isMaintenance: true })).toBe('in progress');
    expect(phaseLabel({ phase: 'resolved', status: 'scheduled', isMaintenance: true })).toContain('completed');
    expect(phaseLabel({ phase: 'active', status: 'investigating', isMaintenance: false })).toBe('');
  });

  it('offers intermediate lifecycle statuses for updates', () => {
    expect([...UPDATE_STATUSES]).toEqual(['investigating', 'identified', 'monitoring', 'resolved']);
  });

  it('groups public incidents by phase with a fallback for older payloads', () => {
    const base = { id: 'i', title: 't', impact: 'minor', isMaintenance: true, updates: [], createdAt: '', updatedAt: '', resolvedAt: null };
    expect(incidentPhase({ ...base, status: 'scheduled', phase: 'upcoming' })).toBe('upcoming');
    expect(incidentPhase({ ...base, status: 'resolved' })).toBe('resolved');
    expect(incidentPhase({ ...base, status: 'investigating' })).toBe('active');
  });
});

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
