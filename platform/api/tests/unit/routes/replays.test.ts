import express from 'express';
import request from 'supertest';
import { gzipSync, gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import { FakeReplayDb } from '../../helpers/fake-replay-db';

const P = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const db = new FakeReplayDb();

jest.mock('../../../src/config/database', () => ({ getDb: jest.fn(async () => db) }));
jest.mock('../../../src/lib/project-access', () => ({ requireProjectAccess: jest.fn() }));
jest.mock('../../../src/lib/privacy-consent', () => ({
  ...jest.requireActual('../../../src/lib/privacy-consent'),
  resolveConsent: jest.fn(),
  upsertConsent: jest.fn(),
}));
jest.mock('../../../src/lib/telemetry-tokens', () => ({
  ...jest.requireActual('../../../src/lib/telemetry-tokens'),
  verifyIngestToken: jest.fn(),
  originAllowed: jest.fn(),
}));
jest.mock('../../../src/middleware/auth', () => ({
  logAudit: jest.fn(async () => undefined),
  allowBrowserSdkToken: (r: any, _s: any, next: any) => { r.browserSdkTokenAllowed = true; next(); },
  // Stand-in for the real middleware: browser tokens only pass on opted-in routes.
  sdkTokenAuth: (r: any, s: any, next: any) => {
    const auth = r.header('Authorization');
    if (auth === 'Bearer sdk_live_browser') {
      if (!r.browserSdkTokenAllowed) return s.status(403).json({ error: 'browser token' });
      r.projectId = P; r.sdkToken = true; return next();
    }
    return s.status(401).json({ error: 'Unauthorized' });
  },
  expressAuthenticate: (r: any, s: any, next: any) => {
    const auth = r.header('Authorization');
    if (!auth) return s.sendStatus(401);
    // Agent tokens: 'Bearer agent:<scope,scope>'.
    if (auth.startsWith('Bearer agent:')) {
      r.agentToken = { id: 'agent-1', name: 'mcp', tokenPrefix: 'plat_agent_x', scopes: auth.slice('Bearer agent:'.length).split(',') };
      return next();
    }
    r.user = { id: 'user-1' }; next();
  },
}));

import router from '../../../src/routes/replays';
import { requireProjectAccess } from '../../../src/lib/project-access';
import { resolveConsent, upsertConsent } from '../../../src/lib/privacy-consent';
import { verifyIngestToken, originAllowed } from '../../../src/lib/telemetry-tokens';
import { logAudit } from '../../../src/middleware/auth';
import { setReplayStoreForTests } from '../../../src/lib/replay-store';
import { MemoryReplayStore } from '../../helpers/memory-replay-store';

const app = express();
app.use(express.json());
app.use(router);

const store = new MemoryReplayStore();
const now = Date.now();

function chunk(extra: Record<string, unknown> = {}, evs?: any[]) {
  const events = evs ?? [
    { type: 4, timestamp: now - 5000, data: { href: 'https://app.example.test/orders/42?x=1', width: 800, height: 600 } },
    { type: 2, timestamp: now - 4999, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'html', attributes: {}, childNodes: [
      { type: 2, tagName: 'body', attributes: {}, childNodes: [{ type: 3, textContent: 'Hello' }] }] }] } } },
    { type: 3, timestamp: now - 4000, data: { source: 5, text: '*****' } },
  ];
  return gzipSync(Buffer.from(JSON.stringify({ v: 1, sessionId: SID, seq: 0, page: '/orders/42', subjectId: 'anon-abcdef12', projectId: OTHER, events, ...extra })));
}

const post = (body: Buffer, token = 'sdk_live_browser', origin?: string) => {
  const r = request(app).post('/sdk/replay/chunks').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream');
  if (origin) r.set('Origin', origin);
  return r.send(body);
};

beforeEach(() => {
  jest.clearAllMocks();
  db.sessions = []; db.chunks = []; db.errorEvents = null;
  store.objects.clear();
  process.env.REPLAY_INGEST = 'on';
  delete process.env.REPLAY_MAX_CHUNK_BYTES;
  setReplayStoreForTests(store);
  (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: true });
  (resolveConsent as jest.Mock).mockResolvedValue({ replayAllowed: false, source: 'default' });
});
afterAll(() => { setReplayStoreForTests(undefined); delete process.env.REPLAY_INGEST; });

describe('POST /sdk/replay/chunks', () => {
  it('is off unless replay ingest is enabled', async () => {
    process.env.REPLAY_INGEST = 'off';
    expect((await post(chunk())).status).toBe(404);
    process.env.REPLAY_INGEST = 'on';
    setReplayStoreForTests(null);
    expect((await post(chunk())).status).toBe(404);
  });

  it('accepts browser SDK tokens, binds the project from the credential and is write-only', async () => {
    const res = await post(chunk());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect([...store.objects.keys()]).toEqual([`replays/${P}/${SID}/0.json.gz`]); // not the envelope's projectId
    expect(db.sessions[0].project_id).toBe(P);
    expect((await post(chunk(), 'nope')).status).toBe(401);
  });

  it('accepts origin-bound browser ingest tokens; wrong origin or server tokens are refused', async () => {
    (verifyIngestToken as jest.Mock).mockResolvedValue({ ok: true, claims: { typ: 'web', projectId: P, environment: 'signed-env', origins: ['https://app.example.test'] } });
    (originAllowed as jest.Mock).mockReturnValue(false);
    expect((await post(chunk(), 'plat_ingest_web_x', 'https://evil.test')).status).toBe(403);
    (originAllowed as jest.Mock).mockReturnValue(true);
    expect((await post(chunk({ environment: 'spoofed' }), 'plat_ingest_web_x', 'https://app.example.test')).status).toBe(202);
    expect(db.sessions[0].environment).toBe('signed-env');
    (verifyIngestToken as jest.Mock).mockResolvedValue({ ok: true, claims: { typ: 'server', projectId: P, environment: 'e', origins: [] } });
    expect((await post(chunk({ seq: 1 }), 'plat_ingest_x', 'https://app.example.test')).status).toBe(403);
    (verifyIngestToken as jest.Mock).mockResolvedValue({ ok: false, reason: 'expired' });
    expect((await post(chunk({ seq: 1 }), 'plat_ingest_web_old')).status).toBe(401);
  });

  it('validates the chunk and enforces size limits', async () => {
    expect((await post(Buffer.from('not gzip'))).status).toBe(400);
    expect((await post(chunk({ sessionId: '../x' }))).status).toBe(400);
    process.env.REPLAY_MAX_CHUNK_BYTES = String(64 * 1024);
    const noisy = randomBytes(70 * 1024).toString('base64');
    const big = chunk({}, [{ type: 5, timestamp: now, data: { tag: 'x', payload: noisy } }]);
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect((await post(big)).status).toBe(413);
    expect(store.objects.size).toBe(0);
  });

  it('answers re-sent chunks with 200 and stores them once; chunks are ordered by seq', async () => {
    expect((await post(chunk({ seq: 1 }, [{ type: 3, timestamp: now - 1000, data: {} }]))).status).toBe(202);
    expect((await post(chunk({ seq: 0 }))).status).toBe(202);
    const dup = await post(chunk({ seq: 0 }));
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect(db.sessions[0].chunk_count).toBe(2);
    const detail = await request(app).get(`/projects/${P}/replays/${SID}`).set('Authorization', 'Bearer human');
    expect(detail.body.chunks.map((c: any) => c.seq)).toEqual([0, 1]);
  });

  it('refuses uploads after consent was withdrawn for the subject', async () => {
    (resolveConsent as jest.Mock).mockResolvedValue({ replayAllowed: false, source: 'recorded' });
    expect((await post(chunk())).status).toBe(403);
    expect(store.objects.size).toBe(0);
  });
});

describe('SDK consent endpoints', () => {
  it('reports and records replay consent for the token project', async () => {
    (resolveConsent as jest.Mock).mockResolvedValue({ replayAllowed: true, source: 'recorded' });
    const allowed = await request(app).get('/sdk/replay/allowed?subjectId=anon-abcdef12&sessionId=s-1').set('Authorization', 'Bearer sdk_live_browser');
    expect(allowed.body).toEqual({ replayAllowed: true });
    expect((resolveConsent as jest.Mock).mock.calls[0][1]).toMatchObject({ projectId: P, subjectId: 'anon-abcdef12' });
    (upsertConsent as jest.Mock).mockResolvedValue({ replayAllowed: true });
    const put = await request(app).put('/sdk/replay/consent').set('Authorization', 'Bearer sdk_live_browser')
      .send({ subjectId: 'anon-abcdef12', replayAllowed: true, projectId: OTHER });
    expect(put.status).toBe(200);
    expect((upsertConsent as jest.Mock).mock.calls[0][1]).toMatchObject({ projectId: P, replayAllowed: true, source: 'sdk' });
    expect((await request(app).put('/sdk/replay/consent').set('Authorization', 'Bearer sdk_live_browser').send({ subjectId: 'x' })).status).toBe(400);
  });
});

describe('portal replay routes', () => {
  beforeEach(async () => {
    await post(chunk());
    jest.clearAllMocks();
    (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: true });
  });

  it('are limited to project members', async () => {
    (requireProjectAccess as jest.Mock).mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });
    for (const path of [`/projects/${P}/replays`, `/projects/${P}/replays/${SID}`, `/projects/${P}/replays/${SID}/chunks/0`, `/projects/${P}/replays/latest/snapshot?page=/orders/42`]) {
      expect((await request(app).get(path).set('Authorization', 'Bearer human')).status).toBe(403);
    }
    expect((await request(app).get(`/projects/${P}/replays`)).status).toBe(401);
    expect((await request(app).get(`/projects/not-a-uuid/replays`).set('Authorization', 'Bearer human')).status).toBe(400);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('lists sessions with filters and audits every session view', async () => {
    const list = await request(app).get(`/projects/${P}/replays?page=orders&errors=false`).set('Authorization', 'Bearer human');
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(list.body.sessions.map((s: any) => s.session_id)).toEqual([SID]);
    expect(list.body.sessions[0]).not.toHaveProperty('subject_id');
    const detail = await request(app).get(`/projects/${P}/replays/${SID}`).set('Authorization', 'Bearer human');
    expect(detail.status).toBe(200);
    expect(detail.body.session.first_page).toBe('/orders/42');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay.view', userId: 'user-1', targetId: P, metadata: { sessionId: SID } }));
    expect((await request(app).get(`/projects/${P}/replays/zzzzzzzz-missing`).set('Authorization', 'Bearer human')).status).toBe(404);
  });

  it('serves stored chunks gzip-encoded and the page snapshot as inert HTML', async () => {
    const res = await request(app).get(`/projects/${P}/replays/${SID}/chunks/0`).set('Authorization', 'Bearer human')
      .buffer(true).parse((r, cb) => { const parts: Buffer[] = []; r.on('data', (d: Buffer) => parts.push(d)); r.on('end', () => cb(null, Buffer.concat(parts))); });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.headers['content-encoding'] === 'gzip' ? JSON.parse((res.body as Buffer).toString()) : JSON.parse(gunzipSync(res.body).toString());
    expect(body.events).toHaveLength(3);
    const snap = await request(app).get(`/projects/${P}/replays/latest/snapshot?page=/orders/:id`).set('Authorization', 'Bearer human');
    expect(snap.status).toBe(200);
    expect(snap.body).toMatchObject({ sessionId: SID, page: '/orders/42', width: 800, height: 600 });
    expect(snap.body.html).toContain('Hello');
    expect(snap.body.html).toContain("script-src 'none'");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay.snapshot_view' }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay.chunk_view', userId: 'user-1', metadata: { sessionId: SID, seq: 0 } }));
    expect((await request(app).get(`/projects/${P}/replays/${SID}/snapshot?page=/missing`).set('Authorization', 'Bearer human')).status).toBe(404);
  });

  it('agent tokens need the replays:read scope and are named in the audit log', async () => {
    for (const path of [`/projects/${P}/replays`, `/projects/${P}/replays/${SID}`, `/projects/${P}/replays/${SID}/chunks/0`, `/projects/${P}/replays/latest/snapshot?page=/orders/42`]) {
      const res = await request(app).get(path).set('Authorization', 'Bearer agent:projects:read,deployments:read');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('replays:read');
    }
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    const ok = await request(app).get(`/projects/${P}/replays/${SID}`).set('Authorization', 'Bearer agent:projects:read,replays:read');
    expect(ok.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'replay.view', userId: undefined, metadata: { sessionId: SID, agentTokenId: 'agent-1', agentTokenName: 'mcp' },
    }));
  });

  it('delete requires devops and removes objects and rows', async () => {
    const res = await request(app).delete(`/projects/${P}/replays/${SID}`).set('Authorization', 'Bearer human');
    expect(res.status).toBe(200);
    expect((requireProjectAccess as jest.Mock).mock.calls[0][2]).toBe('devops');
    expect(store.objects.size).toBe(0);
    expect(db.sessions).toHaveLength(0);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay.delete' }));
  });
});
