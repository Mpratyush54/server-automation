/**
 * #46 — public status-page serializer must expose only published fields and
 * never leak URLs, hosts, errors or secret names from the #42 status feed.
 */
import {
  appendIncidentUpdate,
  buildAtomFeed,
  isValidSlug,
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
      domain: 'status.acme.example',
      status: 'partial_outage',
      branding: { logoUrl: 'https://cdn.example/logo.png', primaryColor: '#112233', accentColor: null },
    });
    expect(payload!.components.map((c) => c.name).sort()).toEqual(['API', 'Checkout']);
    expect(Object.keys(payload!).sort()).toEqual([
      'branding', 'components', 'domain', 'generatedAt', 'incidents', 'slug', 'status', 'title',
    ]);
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
      'createdAt', 'id', 'impact', 'isMaintenance', 'resolvedAt',
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
