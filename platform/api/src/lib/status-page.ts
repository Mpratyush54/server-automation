/**
 * Public status pages (#46): serializers, validation and short-lived cache.
 *
 * Public payloads are built ONLY from #42's StatusFeed (buildStatusFeed /
 * getProjectStatusFeed) plus explicitly published incident fields. Never
 * include URLs, hosts, errors, assertion details, headers or secret names.
 */
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { StatusIncident, StatusIncidentImpact, StatusIncidentLifecycle, StatusIncidentUpdate } from '../entities/StatusIncident';
import { StatusPage, StatusPageBranding } from '../entities/StatusPage';
import { redisKey, stateBackend, withRedis } from './redis';
import {
  getProjectStatusFeed, OverallStatus, StatusFeed, StatusFeedComponent,
} from './synthetic-status';

export const PUBLIC_CACHE_TTL_SEC = 15;
export const PUBLIC_CACHE_CONTROL = `public, max-age=${PUBLIC_CACHE_TTL_SEC}, s-maxage=30`;

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

const LIFECYCLES: StatusIncidentLifecycle[] = [
  'investigating', 'identified', 'monitoring', 'resolved', 'scheduled',
];
const IMPACTS: StatusIncidentImpact[] = ['none', 'minor', 'major', 'critical'];

export interface PublicComponent {
  id: string;
  name: string;
  type: string;
  status: StatusFeedComponent['status'];
  lastCheckedAt: string | null;
  uptime: StatusFeedComponent['uptime'];
  avgLatencyMs24h: number | null;
  days: StatusFeedComponent['days'];
}

export interface PublicIncident {
  id: string;
  title: string;
  status: StatusIncidentLifecycle;
  impact: StatusIncidentImpact;
  isMaintenance: boolean;
  updates: Array<{ at: string; status: StatusIncidentLifecycle; body: string }>;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicStatusPayload {
  slug: string;
  title: string;
  domain: string | null;
  branding: { logoUrl: string | null; primaryColor: string | null; accentColor: string | null };
  generatedAt: string;
  status: OverallStatus;
  components: PublicComponent[];
  incidents: PublicIncident[];
}

export interface AdminStatusPageView {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  domain: string | null;
  published: boolean;
  branding: StatusPageBranding;
  componentIds: string[] | null;
  publicPath: string;
  createdAt: string;
  updatedAt: string;
}

export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug) && slug.length >= 3 && slug.length <= 63;
}

export function isValidDomain(domain: string): boolean {
  return HOST_RE.test(domain) && !domain.includes('://') && !domain.includes('/');
}

export function isValidColor(color: string): boolean {
  return COLOR_RE.test(color);
}

export function publicPathFor(slug: string): string {
  return `/status/${slug}`;
}

/** Admin view (auth required) — never includes secret/check internals. */
export function serializeAdminStatusPage(page: StatusPage): AdminStatusPageView {
  return {
    id: page.id,
    projectId: page.projectId,
    slug: page.slug,
    title: page.title,
    domain: page.domain,
    published: !!page.published,
    branding: {
      logoUrl: page.branding?.logoUrl ?? null,
      primaryColor: page.branding?.primaryColor ?? null,
      accentColor: page.branding?.accentColor ?? null,
    },
    componentIds: page.componentIds === null || page.componentIds === undefined
      ? null
      : [...page.componentIds],
    publicPath: publicPathFor(page.slug),
    createdAt: new Date(page.createdAt).toISOString(),
    updatedAt: new Date(page.updatedAt).toISOString(),
  };
}

/** Strip anything that is not an explicitly published incident field. */
export function serializePublicIncident(inc: StatusIncident): PublicIncident {
  return {
    id: inc.id,
    title: inc.title,
    status: inc.status,
    impact: inc.impact,
    isMaintenance: !!inc.isMaintenance,
    updates: (inc.updates || []).map((u) => ({
      at: u.at,
      status: u.status,
      body: String(u.body || ''),
    })),
    scheduledStart: inc.scheduledStart ? new Date(inc.scheduledStart).toISOString() : null,
    scheduledEnd: inc.scheduledEnd ? new Date(inc.scheduledEnd).toISOString() : null,
    resolvedAt: inc.resolvedAt ? new Date(inc.resolvedAt).toISOString() : null,
    createdAt: new Date(inc.createdAt).toISOString(),
    updatedAt: new Date(inc.updatedAt).toISOString(),
  };
}

/**
 * Pure public serializer (unit-tested). Takes a StatusFeed from #42 and published
 * page/incident rows; returns only fields safe for unauthenticated clients.
 */
export function serializePublicStatusPage(
  page: Pick<StatusPage, 'slug' | 'title' | 'domain' | 'published' | 'branding' | 'componentIds'>,
  feed: StatusFeed,
  incidents: StatusIncident[],
): PublicStatusPayload | null {
  if (!page.published) return null;

  let components = feed.components.map((c): PublicComponent => ({
    id: c.id,
    name: c.name,
    type: c.type,
    status: c.status,
    lastCheckedAt: c.lastCheckedAt,
    uptime: { ...c.uptime },
    avgLatencyMs24h: c.avgLatencyMs24h,
    days: c.days.map((d) => ({ date: d.date, uptime: d.uptime, status: d.status })),
  }));

  if (page.componentIds !== null && page.componentIds !== undefined) {
    const allow = new Set(page.componentIds);
    components = components.filter((c) => allow.has(c.id));
  }

  // Recompute overall from the filtered set (same rules as #42).
  const status = overallFromComponents(components);

  return {
    slug: page.slug,
    title: page.title,
    domain: page.domain,
    branding: {
      logoUrl: page.branding?.logoUrl ?? null,
      primaryColor: page.branding?.primaryColor ?? null,
      accentColor: page.branding?.accentColor ?? null,
    },
    generatedAt: feed.generatedAt,
    status,
    components,
    incidents: incidents.map(serializePublicIncident),
  };
}

function overallFromComponents(components: Array<{ status: PublicComponent['status'] }>): OverallStatus {
  const known = components.filter((c) => c.status !== 'unknown');
  if (known.length === 0) return 'unknown';
  const out = known.filter((c) => c.status === 'outage').length;
  if (out === known.length) return 'major_outage';
  if (out > 0) return 'partial_outage';
  if (known.some((c) => c.status === 'degraded')) return 'degraded';
  return 'operational';
}

export type PagePatch = {
  slug?: string;
  title?: string;
  domain?: string | null;
  published?: boolean;
  branding?: StatusPageBranding;
  componentIds?: string[] | null;
};

export function parsePagePatch(body: any): { ok: true; value: PagePatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be an object' };
  }
  const value: PagePatch = {};
  if (body.slug !== undefined) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!isValidSlug(slug)) return { ok: false, error: 'slug must be 3–63 lowercase letters, digits or hyphens' };
    value.slug = slug;
  }
  if (body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title || title.length > 120) return { ok: false, error: 'title must be 1–120 characters' };
    value.title = title;
  }
  if (body.domain !== undefined) {
    if (body.domain === null || body.domain === '') {
      value.domain = null;
    } else {
      const domain = String(body.domain).trim().toLowerCase();
      if (!isValidDomain(domain)) return { ok: false, error: 'domain must be a hostname (no scheme or path)' };
      value.domain = domain;
    }
  }
  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') return { ok: false, error: 'published must be a boolean' };
    value.published = body.published;
  }
  if (body.branding !== undefined) {
    if (!body.branding || typeof body.branding !== 'object' || Array.isArray(body.branding)) {
      return { ok: false, error: 'branding must be an object' };
    }
    const branding: StatusPageBranding = {};
    if (body.branding.logoUrl !== undefined) {
      if (body.branding.logoUrl === null || body.branding.logoUrl === '') {
        branding.logoUrl = null;
      } else {
        const logo = String(body.branding.logoUrl).trim();
        if (!/^https:\/\//i.test(logo) || logo.length > 500) {
          return { ok: false, error: 'branding.logoUrl must be an https URL' };
        }
        branding.logoUrl = logo;
      }
    }
    for (const key of ['primaryColor', 'accentColor'] as const) {
      if (body.branding[key] !== undefined) {
        if (body.branding[key] === null || body.branding[key] === '') {
          branding[key] = null;
        } else {
          const c = String(body.branding[key]).trim();
          if (!isValidColor(c)) return { ok: false, error: `branding.${key} must be a #RGB or #RRGGBB colour` };
          branding[key] = c;
        }
      }
    }
    value.branding = branding;
  }
  if (body.componentIds !== undefined) {
    if (body.componentIds === null) {
      value.componentIds = null;
    } else if (!Array.isArray(body.componentIds)) {
      return { ok: false, error: 'componentIds must be an array of check ids or null' };
    } else {
      const ids: string[] = [];
      for (const id of body.componentIds) {
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
          return { ok: false, error: 'componentIds must be UUID strings' };
        }
        ids.push(id.toLowerCase());
      }
      value.componentIds = ids;
    }
  }
  return { ok: true, value };
}

export type IncidentCreate = {
  title: string;
  status: StatusIncidentLifecycle;
  impact: StatusIncidentImpact;
  isMaintenance: boolean;
  body?: string;
  scheduledStart?: Date | null;
  scheduledEnd?: Date | null;
};

export function parseIncidentCreate(body: any): { ok: true; value: IncidentCreate } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  const title = String(body.title || '').trim();
  if (!title || title.length > 200) return { ok: false, error: 'title must be 1–200 characters' };
  const status = (body.status || (body.isMaintenance ? 'scheduled' : 'investigating')) as StatusIncidentLifecycle;
  if (!LIFECYCLES.includes(status)) return { ok: false, error: `status must be one of ${LIFECYCLES.join(', ')}` };
  const impact = (body.impact || 'minor') as StatusIncidentImpact;
  if (!IMPACTS.includes(impact)) return { ok: false, error: `impact must be one of ${IMPACTS.join(', ')}` };
  const isMaintenance = !!body.isMaintenance;
  let scheduledStart: Date | null = null;
  let scheduledEnd: Date | null = null;
  if (body.scheduledStart) {
    scheduledStart = new Date(body.scheduledStart);
    if (Number.isNaN(scheduledStart.getTime())) return { ok: false, error: 'scheduledStart is invalid' };
  }
  if (body.scheduledEnd) {
    scheduledEnd = new Date(body.scheduledEnd);
    if (Number.isNaN(scheduledEnd.getTime())) return { ok: false, error: 'scheduledEnd is invalid' };
  }
  const value: IncidentCreate = { title, status, impact, isMaintenance, scheduledStart, scheduledEnd };
  if (body.body !== undefined) {
    const b = String(body.body || '').trim();
    if (b.length > 4000) return { ok: false, error: 'body must be at most 4000 characters' };
    value.body = b;
  }
  return { ok: true, value };
}

export function parseIncidentUpdateBody(body: any): { ok: true; status: StatusIncidentLifecycle; body: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  const status = body.status as StatusIncidentLifecycle;
  if (!LIFECYCLES.includes(status)) return { ok: false, error: `status must be one of ${LIFECYCLES.join(', ')}` };
  const text = String(body.body || '').trim();
  if (!text || text.length > 4000) return { ok: false, error: 'body must be 1–4000 characters' };
  return { ok: true, status, body: text };
}

export function appendIncidentUpdate(
  incident: StatusIncident,
  status: StatusIncidentLifecycle,
  body: string,
  by?: string | null,
  now = new Date(),
): StatusIncident {
  const entry: StatusIncidentUpdate = {
    at: now.toISOString(),
    status,
    body,
    by: by || null,
  };
  incident.updates = [...(incident.updates || []), entry];
  incident.status = status;
  if (status === 'resolved') {
    incident.resolvedAt = now;
  } else if (incident.resolvedAt) {
    incident.resolvedAt = null;
  }
  return incident;
}

function cacheKey(slug: string): string {
  return redisKey(`status:public:${slug}`);
}

export async function invalidatePublicCache(slug: string): Promise<void> {
  if (stateBackend() !== 'redis') return;
  try {
    await withRedis((r) => r.del(cacheKey(slug)));
  } catch { /* cache is best-effort */ }
}

export async function readPublicCache(slug: string): Promise<PublicStatusPayload | null> {
  if (stateBackend() !== 'redis') return null;
  try {
    const raw = await withRedis((r) => r.get(cacheKey(slug)));
    if (!raw) return null;
    return JSON.parse(raw) as PublicStatusPayload;
  } catch {
    return null;
  }
}

export async function writePublicCache(slug: string, payload: PublicStatusPayload): Promise<void> {
  if (stateBackend() !== 'redis') return;
  try {
    await withRedis((r) => r.set(cacheKey(slug), JSON.stringify(payload), 'EX', PUBLIC_CACHE_TTL_SEC));
  } catch { /* ignore */ }
}

/** Load the published page + #42 feed + recent incidents into a public payload. */
export async function buildPublicStatusPayload(slug: string, now = new Date()): Promise<PublicStatusPayload | null> {
  const ds = await getDb();
  const page = await ds.getRepository(StatusPage).findOne({ where: { slug } });
  if (!page || !page.published) return null;

  const [feed, incidents] = await Promise.all([
    getProjectStatusFeed(page.projectId, now),
    ds.getRepository(StatusIncident).find({
      where: { statusPageId: page.id },
      order: { createdAt: 'DESC' },
      take: 50,
    }),
  ]);

  return serializePublicStatusPage(page, feed, incidents);
}

export async function getOrCreateStatusPage(projectId: string, createdById?: string | null): Promise<StatusPage> {
  const ds = await getDb();
  const repo = ds.getRepository(StatusPage);
  const existing = await repo.findOne({ where: { projectId } });
  if (existing) return existing;

  const project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
  const base = slugify(project?.name || 'status');
  let slug = base;
  for (let i = 0; i < 20; i++) {
    const clash = await repo.findOne({ where: { slug } });
    if (!clash) break;
    slug = `${base}-${i + 2}`.slice(0, 63);
  }
  const page = repo.create({
    projectId,
    slug,
    title: project?.name ? `${project.name} Status` : 'Status',
    domain: null,
    published: false,
    branding: {},
    componentIds: null,
    createdById: createdById || null,
  });
  return repo.save(page);
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s.length >= 3 ? s : `status-${s || 'page'}`.slice(0, 63);
}

/** Atom 1.0 feed of incidents (optional subscription channel). */
export function buildAtomFeed(payload: PublicStatusPayload, selfUrl: string): string {
  const entries = payload.incidents.map((inc) => {
    const updated = inc.updatedAt;
    const summary = escapeXml(inc.updates[inc.updates.length - 1]?.body || inc.title);
    return `  <entry>
    <id>urn:status-incident:${inc.id}</id>
    <title>${escapeXml(inc.title)}</title>
    <updated>${updated}</updated>
    <summary>${summary}</summary>
  </entry>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(payload.title)}</title>
  <id>urn:status-page:${escapeXml(payload.slug)}</id>
  <updated>${payload.generatedAt}</updated>
  <link rel="self" href="${escapeXml(selfUrl)}"/>
  <subtitle>Status and incidents for ${escapeXml(payload.title)}</subtitle>
${entries}
</feed>
`;
}

/** RSS 2.0 feed of incidents. */
export function buildRssFeed(payload: PublicStatusPayload, selfUrl: string): string {
  const items = payload.incidents.map((inc) => {
    const desc = escapeXml(inc.updates[inc.updates.length - 1]?.body || inc.title);
    return `    <item>
      <title>${escapeXml(inc.title)}</title>
      <guid isPermaLink="false">urn:status-incident:${inc.id}</guid>
      <pubDate>${new Date(inc.createdAt).toUTCString()}</pubDate>
      <description>${desc}</description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(payload.title)}</title>
    <link>${escapeXml(selfUrl.replace(/\/rss$/, ''))}</link>
    <description>Status and incidents for ${escapeXml(payload.title)}</description>
    <lastBuildDate>${new Date(payload.generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
