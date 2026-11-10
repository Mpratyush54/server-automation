import express from 'express';
import request from 'supertest';

process.env.HEATMAP_PROJECT_RATE_LIMIT = '12';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../../src/lib/project-access', () => ({ requireProjectAccess: jest.fn() }));
jest.mock('../../../src/lib/privacy-consent', () => ({ resolveConsent: jest.fn() }));
jest.mock('../../../src/lib/telemetry-tokens', () => ({
  looksLikeIngestToken: (t: string) => t.startsWith('plat_ingest_'),
  verifyIngestToken: jest.fn(),
  originAllowed: jest.fn(),
}));
// Mirrors middleware/auth: a browser-kind SDK token is refused unless the route opted in.
jest.mock('../../../src/middleware/auth', () => ({
  allowBrowserSdkToken: (r: any, _: any, next: any) => { r.browserSdkTokenAllowed = true; next(); },
  sdkTokenAuth: (r: any, s: any, next: any) => {
    const auth = r.header('Authorization') || '';
    if (!auth.startsWith('Bearer sdk_')) return s.status(401).json({ error: 'no token' });
    const projectId = auth.includes('ratelimit') ? '33333333-3333-4333-8333-333333333333' : auth.includes('other') ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
    if (auth.includes('browser') && !r.browserSdkTokenAllowed) return s.status(403).json({ error: 'browser token' });
    r.sdkToken = true; r.projectId = projectId; next();
  },
  expressAuthenticate: (r: any, s: any, next: any) => (r.header('Authorization') ? next() : s.sendStatus(401)),
}));

import router from '../../../src/routes/heatmaps';
import { getDb } from '../../../src/config/database';
import { requireProjectAccess } from '../../../src/lib/project-access';
import { resolveConsent } from '../../../src/lib/privacy-consent';
import { verifyIngestToken, originAllowed } from '../../../src/lib/telemetry-tokens';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use(router);

let db: { query: jest.Mock };
let ipSeq = 0;
const ip = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const click = { type: 'click', page: '/orders/42', viewport: 'desktop', x: 0.5, y: 0.5, selector: 'button#buy' };
const scroll = { type: 'scroll', page: '/orders/42', viewport: 'desktop', depth: 80 };

beforeEach(() => {
  jest.clearAllMocks();
  db = { query: jest.fn(async (sql: string) => (sql.startsWith('SELECT count') ? [{ n: 0 }] : [])) };
  (getDb as jest.Mock).mockResolvedValue(db);
  (resolveConsent as jest.Mock).mockResolvedValue({ analyticsAllowed: true });
  (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: true });
});

describe('POST /sdk/heatmap/events', () => {
  it('accepts a browser SDK token (explicit opt-in), scopes to the token project and is write-only', async () => {
    const res = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip())
      .set('Authorization', 'Bearer sdk_live_browser_token')
      .send({ projectId: OTHER, events: [click, click, scroll] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 3 });
    const inserts = db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const [, params] of inserts) expect(params[0]).toBe(PROJECT);
    const pages = inserts.find(([sql]) => sql.includes('heatmap_pages'))!;
    expect(pages[1][2]).toEqual(['/orders/:id']);
  });

  it('requires a credential', async () => {
    expect((await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).send({ events: [click] })).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('accepts the RUM web ingest token only from an allowed origin', async () => {
    (verifyIngestToken as jest.Mock).mockResolvedValue({ ok: true, claims: { typ: 'web', projectId: OTHER, origins: ['https://app.example.test'] } });
    (originAllowed as jest.Mock).mockReturnValue(false);
    const denied = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip())
      .set('Authorization', 'Bearer plat_ingest_web_x').set('Origin', 'https://evil.example.test').send({ events: [click] });
    expect(denied.status).toBe(403);
    (originAllowed as jest.Mock).mockReturnValue(true);
    const ok = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip())
      .set('Authorization', 'Bearer plat_ingest_web_x').set('Origin', 'https://app.example.test').send({ events: [click] });
    expect(ok.status).toBe(202);
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT')).every(([, p]) => p[0] === OTHER)).toBe(true);
    (verifyIngestToken as jest.Mock).mockResolvedValue({ ok: false, reason: 'expired' });
    expect((await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip())
      .set('Authorization', 'Bearer plat_ingest_web_x').send({ events: [click] })).status).toBe(401);
  });

  it('validates the batch and size', async () => {
    const auth = { Authorization: 'Bearer sdk_live_browser_token' };
    expect((await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).set(auth).send({ events: 'x' })).status).toBe(400);
    expect((await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).set(auth).send({ events: [] })).status).toBe(400);
    const big = { events: [{ ...click, selector: 'x'.repeat(70 * 1024) }] };
    expect((await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).set(auth).send(big)).status).toBe(413);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('drops everything for Do-Not-Track / GPC and when #47 analytics consent is denied', async () => {
    const auth = { Authorization: 'Bearer sdk_live_browser_token' };
    const dnt = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).set(auth).set('DNT', '1').send({ events: [click] });
    expect(dnt.status).toBe(202);
    expect(dnt.body).toEqual({ accepted: 0 });
    const gpc = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).set(auth).set('Sec-GPC', '1').send({ events: [click] });
    expect(gpc.body).toEqual({ accepted: 0 });
    (resolveConsent as jest.Mock).mockResolvedValue({ analyticsAllowed: false });
    const denied = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip()).set(auth).send({ subjectId: 'user-1', events: [click] });
    expect(denied.body).toEqual({ accepted: 0, consent: false });
    expect(resolveConsent).toHaveBeenCalledWith(db, expect.objectContaining({ projectId: PROJECT, subjectId: 'user-1' }));
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rate limits per project across client IPs', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await request(app).post('/sdk/heatmap/events').set('X-Forwarded-For', ip())
        .set('Authorization', 'Bearer sdk_live_ratelimit_browser').send({ events: [scroll] });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 12).every((s) => s === 202)).toBe(true);
    expect(statuses.slice(12)).toEqual([429, 429]);
  });
});

describe('GET /projects/:projectId/heatmaps', () => {
  it('is for project members only', async () => {
    (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });
    expect((await request(app).get(`/projects/${PROJECT}/heatmaps?page=/a`).set('Authorization', 'Bearer u')).status).toBe(403);
    expect((await request(app).get(`/projects/${PROJECT}/heatmaps/pages`).set('Authorization', 'Bearer u')).status).toBe(403);
    expect((await request(app).get(`/projects/${PROJECT}/heatmaps?page=/a`)).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('validates query parameters', async () => {
    const get = (q: string) => request(app).get(`/projects/${PROJECT}/heatmaps${q}`).set('Authorization', 'Bearer u');
    expect((await get('')).status).toBe(400);
    expect((await get('?page=/a&type=hover')).status).toBe(400);
    expect((await get('?page=/a&viewport=watch')).status).toBe(400);
    expect((await get('?page=/a&from=2026-11-09&to=2026-11-01')).status).toBe(400);
    expect((await request(app).get('/projects/not-a-uuid/heatmaps?page=/a').set('Authorization', 'Bearer u')).status).toBe(400);
  });

  it('returns click and scroll aggregates for a normalised page', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM heatmap_click_cells')) return [{ cell_x: 50, cell_y: 10, count: '4' }];
      if (sql.includes('FROM heatmap_click_targets')) return [{ selector: 'button#buy', count: '4' }];
      if (sql.includes('FROM heatmap_scroll_depth')) return [{ depth: 50, count: '1' }, { depth: 100, count: '1' }];
      return [];
    });
    const c = await request(app).get(`/projects/${PROJECT}/heatmaps?page=/orders/7&viewport=desktop&from=2026-11-01&to=2026-11-07`).set('Authorization', 'Bearer u');
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ type: 'click', page: '/orders/:id', viewport: 'desktop', total: 4, maxCell: 4, cells: [[50, 10, 4]] });
    expect(db.query.mock.calls[0][1]).toEqual([PROJECT, '/orders/:id', '2026-11-01', '2026-11-07', 'desktop']);
    const s = await request(app).get(`/projects/${PROJECT}/heatmaps?page=/orders/7&type=scroll`).set('Authorization', 'Bearer u');
    expect(s.body).toMatchObject({ type: 'scroll', views: 2, viewport: 'all' });
    expect(s.body.reach.find((r: any) => r.depth === 55).pct).toBe(50);
  });

  it('lists pages with counts', async () => {
    db.query.mockResolvedValue([{ page: '/a', clicks: '3', views: '2' }]);
    const r = await request(app).get(`/projects/${PROJECT}/heatmaps/pages?viewport=mobile`).set('Authorization', 'Bearer u');
    expect(r.status).toBe(200);
    expect(r.body.pages).toEqual([{ page: '/a', clicks: 3, views: 2 }]);
    expect(r.body.viewport).toBe('mobile');
  });
});
