/**
 * #46 — public status-page serializer must expose only published fields and
 * never leak URLs, hosts, errors or secret names from the #42 status feed.
 */
import {
  appendIncidentUpdate,
  buildAtomFeed,
  buildRssFeed,
  clearMemoryPublicCache,
  incidentPhase,
  invalidatePublicCache,
  isValidSlug,
  MEMORY_CACHE_MAX_ENTRIES,
  memoryPublicCacheSize,
  readPublicCache,
  serializeAdminIncident,
  shouldFireIncidentAlert,
  writePublicCache,
  parseIncidentCreate,
  parsePagePatch,
  serializePublicIncident,
  serializePublicStatusPage,
} from '../../../src/lib/status-page';
import { buildStatusFeed } from '../../../src/lib/synthetic-status';
import type { StatusIncident } from '../../../src/entities/StatusIncident';

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-11-10T12:00:00Z');

const checks: any[] = [
  {
    id: 'c1', name: 'API health', type: 'http', enabled: true, lastStatus: 'up',
    lastRunAt: new Date('2026-11-10T11:59:00Z'),
    config: {
      url: 'https://internal-secret.example.com/v1/health',
      headers: { Authorization: '{{secret.TOKEN}}' },
      statusPage: { visible: true, name: 'API' },
    },
  },
  {
    id: 'c2', name: 'Checkout', type: 'browser', enabled: true, lastStatus: 'down', lastRunAt: now,
    config: { steps: [{ action: 'goto', url: 'https://shop.example.com/checkout' }] },
  },
  {
    id: 'c3', name: 'Hidden SSL', type: 'ssl', enabled: true, lastStatus: 'up', lastRunAt: now,
    config: { host: 'db.internal', statusPage: { visible: false } },
  },
];

const feed = buildStatusFeed(
  PROJ,
  checks,
  [
    { checkId: 'c1', day: '2026-11-10', total: 100, failed: 0, avgLatencyMs: 40 },
    { checkId: 'c2', day: '2026-11-10', total: 10, failed: 10, avgLatencyMs: 800 },
  ],
  [{ checkId: 'c1', day: null, total: 100, failed: 0, avgLatencyMs: 42 }],
  now,
);

const page = {
  slug: 'acme',
  title: 'Acme Status',
  domain: 'status.acme.example',
  published: true,
  branding: { logoUrl: 'https://cdn.example/logo.png', primaryColor: '#112233', accentColor: null },
  componentIds: null as string[] | null,
};

function incident(partial: Partial<StatusIncident> = {}): StatusIncident {
  return {
    id: 'i1',
    statusPageId: 'p1',
    projectId: PROJ,
    title: 'Elevated errors',
    status: 'investigating',
    impact: 'major',
    isMaintenance: false,
    updates: [{ at: now.toISOString(), status: 'investigating', body: 'Looking into it', by: 'uid' }],
    scheduledStart: null,
    scheduledEnd: null,
    resolvedAt: null,
    createdById: 'uid',
    createdAt: now,
    updatedAt: now,
    ...partial,
  } as StatusIncident;
}

describe('serializePublicStatusPage (#46)', () => {
  it('returns null when the page is not published', () => {
    expect(serializePublicStatusPage({ ...page, published: false }, feed, [])).toBeNull();
  });

  it('exposes only published fields and feed aggregates', () => {
    const payload = serializePublicStatusPage(page, feed, [incident()]);
    expect(payload).toMatchObject({
      slug: 'acme',
      title: 'Acme Status',
      status: 'partial_outage',
      branding: { logoUrl: 'https://cdn.example/logo.png', primaryColor: '#112233', accentColor: null },
    });
    expect(payload!.components.map((c) => c.name).sort()).toEqual(['API', 'Checkout']);
    expect(Object.keys(payload!).sort()).toEqual([
      'branding', 'components', 'generatedAt', 'incidents', 'slug', 'status', 'title',
    ]);
    // domain is stored but unused, so it must not be published
    expect(JSON.stringify(payload)).not.toContain('status.acme.example');
    const api = payload!.components.find((c) => c.id === 'c1')!;
    expect(Object.keys(api).sort()).toEqual([
      'avgLatencyMs24h', 'days', 'id', 'lastCheckedAt', 'name', 'status', 'type', 'uptime',
    ]);
    expect(payload!.incidents[0]).toMatchObject({
      title: 'Elevated errors',
      status: 'investigating',
      updates: [{ body: 'Looking into it', status: 'investigating' }],
    });
    // author id must not appear on public updates
    expect((payload!.incidents[0].updates[0] as any).by).toBeUndefined();
  });

  it('never leaks URLs, hosts, errors or secret names from the feed source', () => {
    const payload = serializePublicStatusPage(page, feed, [incident()]);
    const text = JSON.stringify(payload);
    for (const leak of [
      'internal-secret', 'example.com/v1', 'Authorization', 'secret.TOKEN',
      'shop.example.com', 'db.internal', 'Hidden SSL', 'steps', 'goto', PROJ,
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('filters components when componentIds is set', () => {
    const payload = serializePublicStatusPage({ ...page, componentIds: ['c1'] }, feed, []);
    expect(payload!.components.map((c) => c.id)).toEqual(['c1']);
    expect(payload!.status).toBe('operational');
  });

  it('shows no components when componentIds is empty', () => {
    const payload = serializePublicStatusPage({ ...page, componentIds: [] }, feed, []);
    expect(payload!.components).toEqual([]);
    expect(payload!.status).toBe('unknown');
  });
});

describe('serializePublicIncident', () => {
  it('drops the update author field', () => {
    const pub = serializePublicIncident(incident());
    expect(pub.updates[0]).toEqual({
      at: now.toISOString(),
      status: 'investigating',
      body: 'Looking into it',
    });
    expect(Object.keys(pub).sort()).toEqual([
      'createdAt', 'id', 'impact', 'isMaintenance', 'phase', 'resolvedAt',
      'scheduledEnd', 'scheduledStart', 'status', 'title', 'updatedAt', 'updates',
    ]);
  });
});

describe('validation helpers', () => {
  it('accepts valid slugs', () => {
    expect(isValidSlug('acme')).toBe(true);
    expect(isValidSlug('acme-status')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('-acme')).toBe(false);
  });

  it('parses page patches', () => {
    expect(parsePagePatch({ slug: 'Ok-Slug', published: true }).ok).toBe(true);
    expect(parsePagePatch({ slug: 'x' }).ok).toBe(false);
    expect(parsePagePatch({ domain: 'https://bad' }).ok).toBe(false);
    expect(parsePagePatch({ branding: { primaryColor: 'red' } }).ok).toBe(false);
    expect(parsePagePatch({ branding: { primaryColor: '#abc' } })).toMatchObject({ ok: true });
  });

  it('parses incident creates', () => {
    expect(parseIncidentCreate({ title: 'Down', impact: 'critical' })).toMatchObject({
      ok: true,
      value: { title: 'Down', impact: 'critical', status: 'investigating' },
    });
    expect(parseIncidentCreate({ title: '' }).ok).toBe(false);
  });

  it('appends incident updates and resolves', () => {
    const inc = incident();
    appendIncidentUpdate(inc, 'resolved', 'Fixed', 'uid', new Date('2026-11-10T13:00:00Z'));
    expect(inc.status).toBe('resolved');
    expect(inc.resolvedAt?.toISOString()).toBe('2026-11-10T13:00:00.000Z');
    expect(inc.updates).toHaveLength(2);
  });
});

describe('Atom feed', () => {
  it('renders incidents without leaking internals', () => {
    const payload = serializePublicStatusPage(page, feed, [incident()])!;
    const xml = buildAtomFeed(payload, 'https://example.test/api/public/status/acme/atom');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('Elevated errors');
    expect(xml).not.toContain('internal-secret');
    expect(xml).not.toContain('uid');
  });
});

describe('maintenance windows', () => {
  const start = new Date('2026-11-10T14:00:00Z');
  const end = new Date('2026-11-10T15:00:00Z');
  const maint = (p: Partial<StatusIncident> = {}) => incident({
    isMaintenance: true, status: 'scheduled', impact: 'minor', scheduledStart: start, scheduledEnd: end, ...p,
  });

  it('is upcoming before the window, active inside it, completed after it', () => {
    expect(incidentPhase(maint(), new Date('2026-11-10T13:59:59Z'))).toBe('upcoming');
    expect(incidentPhase(maint(), start)).toBe('active');
    expect(incidentPhase(maint(), new Date('2026-11-10T14:30:00Z'))).toBe('active');
    expect(incidentPhase(maint(), end)).toBe('resolved');
    expect(incidentPhase(maint({ scheduledStart: null, scheduledEnd: null }), now)).toBe('active');
    expect(incidentPhase(maint({ status: 'resolved' }), now)).toBe('resolved');
    // ordinary incidents are never time-driven
    expect(incidentPhase(incident({ scheduledStart: start, scheduledEnd: end }), now)).toBe('active');
  });

  it('public output reports maintenance past its window as resolved at scheduledEnd', () => {
    const after = new Date('2026-11-10T16:00:00Z');
    const pub = serializePublicIncident(maint(), after);
    expect(pub).toMatchObject({ status: 'resolved', phase: 'resolved', resolvedAt: end.toISOString() });
    // the admin view keeps the stored status but exposes the phase
    expect(serializeAdminIncident(maint(), after)).toMatchObject({ status: 'scheduled', phase: 'resolved', resolvedAt: null });
  });

  it('public payload keeps future maintenance out of the active set', () => {
    const payload = serializePublicStatusPage(page, feed, [maint()], now)!;
    expect(payload.incidents[0]).toMatchObject({
      phase: 'upcoming', status: 'scheduled',
      scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(),
    });
  });

  it('feeds label scheduled maintenance and include the window', () => {
    const payload = serializePublicStatusPage(page, feed, [maint()], now)!;
    const atom = buildAtomFeed(payload, 'https://x.test/api/public/status/acme/atom', 'https://x.test/status/acme');
    expect(atom).toContain('Scheduled maintenance: Elevated errors');
    expect(atom).toContain('Window: Tue, 10 Nov 2026 14:00 UTC – Tue, 10 Nov 2026 15:00 UTC');
  });

  it('rejects windows that end before they start and drops windows on incidents', () => {
    expect(parseIncidentCreate({
      title: 'm', isMaintenance: true, scheduledStart: end.toISOString(), scheduledEnd: start.toISOString(),
    }).ok).toBe(false);
    expect(parseIncidentCreate({
      title: 'i', scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(),
    })).toMatchObject({ ok: true, value: { scheduledStart: null, scheduledEnd: null } });
  });
});

describe('alert emission condition', () => {
  it('fires only for published, major/critical, non-maintenance, unresolved incidents', () => {
    const base = { impact: 'major', isMaintenance: false, status: 'investigating' } as const;
    expect(shouldFireIncidentAlert({ published: true }, base)).toBe(true);
    expect(shouldFireIncidentAlert({ published: true }, { ...base, impact: 'critical' })).toBe(true);
    expect(shouldFireIncidentAlert({ published: false }, base)).toBe(false);
    expect(shouldFireIncidentAlert({ published: true }, { ...base, impact: 'minor' })).toBe(false);
    expect(shouldFireIncidentAlert({ published: true }, { ...base, isMaintenance: true })).toBe(false);
    expect(shouldFireIncidentAlert({ published: true }, { ...base, status: 'resolved' })).toBe(false);
  });
});

describe('feed links', () => {
  it('RSS channel and items link to the public HTML page, Atom has an alternate link', () => {
    const payload = serializePublicStatusPage(page, feed, [incident()])!;
    const rss = buildRssFeed(payload, 'https://x.test/status/acme');
    expect(rss).toContain('<link>https://x.test/status/acme</link>');
    expect(rss).not.toContain('/api/public/status');
    const atom = buildAtomFeed(payload, 'https://x.test/api/public/status/acme/atom', 'https://x.test/status/acme');
    expect(atom).toContain('<link rel="alternate" type="text/html" href="https://x.test/status/acme"/>');
    expect(atom).toContain('<link rel="self" href="https://x.test/api/public/status/acme/atom"/>');
  });
});

describe('in-process public cache (no Redis)', () => {
  beforeEach(() => clearMemoryPublicCache());

  it('serves within the 15 s TTL, expires after it, and invalidates', async () => {
    const payload = serializePublicStatusPage(page, feed, [])!;
    const t0 = 1_000_000;
    await writePublicCache('acme', payload, t0);
    expect(await readPublicCache('acme', t0 + 14_000)).toBe(payload);
    expect(await readPublicCache('acme', t0 + 15_000)).toBeNull();

    await writePublicCache('acme', payload, t0);
    await invalidatePublicCache('acme');
    expect(await readPublicCache('acme', t0 + 1)).toBeNull();
  });

  it('is bounded and evicts the oldest slug first', async () => {
    const payload = serializePublicStatusPage(page, feed, [])!;
    for (let i = 0; i < MEMORY_CACHE_MAX_ENTRIES + 10; i++) {
      await writePublicCache(`slug-${i}`, payload, 1000);
    }
    expect(memoryPublicCacheSize()).toBe(MEMORY_CACHE_MAX_ENTRIES);
    expect(await readPublicCache('slug-0', 1001)).toBeNull();
    expect(await readPublicCache(`slug-${MEMORY_CACHE_MAX_ENTRIES + 9}`, 1001)).toBe(payload);
  });
});
