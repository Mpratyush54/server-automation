import {
  ALERT_EVENTS_STREAM,
  publishAlertEvent,
  setAlertEventTestHook,
} from '../../../src/lib/alert-events';

describe('alert-events contract', () => {
  afterEach(() => setAlertEventTestHook(null));

  it('exposes the shared stream key and captures via the test hook', async () => {
    expect(ALERT_EVENTS_STREAM).toContain('alerts:events');
    const seen: any[] = [];
    setAlertEventTestHook((e) => { seen.push(e); });
    await publishAlertEvent({
      projectId: 'p1',
      source: 'error-tracking',
      severity: 'warning',
      dedupeKey: 'error:abc',
      title: 'New issue',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe('firing');
    expect(seen[0].dedupeKey).toBe('error:abc');
  });
});
