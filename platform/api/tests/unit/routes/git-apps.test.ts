/**
 * #35 routes: admin-only writes with MFA step-up and audit entries; GET never returns secrets.
 */
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { MemoryRepo } from '../../helpers/memory-repo';

class Repo<T extends Record<string, any>> extends MemoryRepo<T> {
  async clear() { this.rows = []; }
}
const repos: Record<string, Repo<any>> = {};
function repoFor(name: string) {
  if (!repos[name]) repos[name] = new Repo<any>();
  return repos[name];
}

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: (entity: any) => repoFor(entity.name) })),
}));

const audit = jest.fn();
jest.mock('../../../src/middleware/auth', () => {
  const actual = jest.requireActual('../../../src/middleware/auth');
  const USERS: Record<string, any> = {
    admin: { id: 'admin-1', role: 'admin', roleId: null },
    admin2: { id: 'admin-2', role: 'admin', roleId: null },
    devops: { id: 'devops-1', role: 'devops', roleId: null },
    dev: { id: 'dev-1', role: 'developer', roleId: null },
  };
  return {
    ...actual,
    expressAuthenticate: (req: any, res: any, next: any) => {
      const u = USERS[String(req.headers['x-test-user'] || '')];
      if (!u) return res.status(401).json({ error: 'Unauthorized' });
      req.user = u;
      req.humanJwt = true;
      const now = Math.floor(Date.now() / 1000);
      req.session = { amr: req.headers['x-test-mfa'] ? ['pwd', 'mfa'] : ['pwd'], authTime: now, mfaEnroll: false };
      next();
    },
    logAudit: (...args: any[]) => audit(...args),
  };
});

import gitAppRoutes from '../../../src/routes/git-apps';
import { clearManifestStatesForTests } from '../../../src/lib/github-app';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const CONVERSION = {
  id: 5150, slug: 'platform-routes', owner: { login: 'acme', type: 'User' },
  client_id: 'Iv1.routeclient', client_secret: 'route-client-secret-0123456789',
  webhook_secret: 'route-webhook-secret-0123456789', pem: privateKey,
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', gitAppRoutes);
  return a;
}
const as = (user: string, mfa = false) => {
  const h: Record<string, string> = { 'x-test-user': user, host: 'platform.example.test', 'x-forwarded-proto': 'https' };
  if (mfa) h['x-test-mfa'] = '1';
  return h;
};
function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const originalFetch = global.fetch;
beforeEach(() => {
  for (const k of Object.keys(repos)) delete repos[k];
  clearManifestStatesForTests();
  audit.mockReset();
  process.env.JWT_SECRET = 'git-apps-route-test-secret-0123456789';
  process.env.DOMAIN = 'platform.example.test';
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.DOMAIN;
});

async function connectGithub() {
  const start = await request(app()).post('/api/settings/integrations/github/manifest').set(as('admin', true)).send({});
  expect(start.status).toBe(200);
  global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(201, CONVERSION)) as any;
  return request(app()).post('/api/settings/integrations/github/manifest/complete').set(as('admin', true)).send({ code: 'abc', state: start.body.state });
}

describe('GitHub manifest endpoints', () => {
  it('are admin-only', async () => {
    const r = await request(app()).post('/api/settings/integrations/github/manifest').set(as('devops', true)).send({});
    expect(r.status).toBe(403);
  });

  it('require a recent MFA step-up', async () => {
    const r = await request(app()).post('/api/settings/integrations/github/manifest').set(as('admin')).send({});
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('step_up_required');
  });

  it('return the manifest + post URL and audit the start', async () => {
    const r = await request(app()).post('/api/settings/integrations/github/manifest').set(as('admin', true)).send({ ownerType: 'org', org: 'acme' });
    expect(r.status).toBe(200);
    expect(r.body.postUrl).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/);
    expect(r.body.manifest.hook_attributes.url).toBe('https://platform.example.test/api/webhooks/github');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'settings.git.github.manifest_started', userId: 'admin-1' }));
  });

  it('reject completion by a different admin', async () => {
    const start = await request(app()).post('/api/settings/integrations/github/manifest').set(as('admin', true)).send({});
    global.fetch = jest.fn() as any;
    const r = await request(app()).post('/api/settings/integrations/github/manifest/complete').set(as('admin2', true)).send({ code: 'abc', state: start.body.state });
    expect(r.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('store the App and never return its secrets', async () => {
    const done = await connectGithub();
    expect(done.status).toBe(200);
    expect(done.body.installUrl).toBe('https://github.com/apps/platform-routes/installations/new');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'settings.git.github.connected' }));

    const status = await request(app()).get('/api/settings/integrations/git').set(as('devops'));
    expect(status.status).toBe(200);
    expect(status.body.github).toMatchObject({ connected: true, slug: 'platform-routes', loginSource: 'app', hasPrivateKey: true });
    const text = JSON.stringify(status.body) + JSON.stringify(done.body);
    expect(text).not.toContain(CONVERSION.client_secret);
    expect(text).not.toContain(CONVERSION.webhook_secret);
    expect(text).not.toContain('PRIVATE KEY');
  });
});

describe('status, GitLab connect and disconnect', () => {
  it('status is hidden from developers', async () => {
    const r = await request(app()).get('/api/settings/integrations/git').set(as('dev'));
    expect(r.status).toBe(403);
  });

  it('GitLab connect is admin-only with step-up and audited', async () => {
    expect((await request(app()).post('/api/settings/integrations/gitlab/connect').set(as('admin')).send({})).status).toBe(401);
    global.fetch = jest.fn(async (url: string, init: any = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/v4/user') return jsonResponse(200, { id: 1, is_admin: true });
      if (path === '/api/v4/applications' && init.method === 'POST') return jsonResponse(201, { id: 3, application_id: 'gl-app', secret: 'gl-route-secret' });
      return jsonResponse(404, {});
    }) as any;
    const r = await request(app()).post('/api/settings/integrations/gitlab/connect').set(as('admin', true))
      .send({ baseUrl: 'https://gitlab.example.test', token: 'glpat-route-token' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'instance', tokenKept: false });
    expect(JSON.stringify(r.body)).not.toContain('gl-route-secret');
    expect(JSON.stringify(r.body)).not.toContain('glpat-route-token');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'settings.git.gitlab.connected' }));
    const post = (global.fetch as jest.Mock).mock.calls.find(([, i]) => i?.method === 'POST');
    expect(JSON.parse(post[1].body).redirect_uri).toBe('https://platform.example.test/api/auth/gitlab/callback');
  });

  it('GitLab manual fallback is surfaced as 422 with the redirect URI', async () => {
    global.fetch = jest.fn(async (url: string) => (new URL(url).pathname === '/api/v4/user' ? jsonResponse(200, { id: 1, is_admin: false }) : jsonResponse(404, {}))) as any;
    const r = await request(app()).post('/api/settings/integrations/gitlab/connect').set(as('admin', true))
      .send({ baseUrl: 'https://gitlab.example.test', token: 'glpat-x', groupPath: 'team' });
    expect(r.status).toBe(422);
    expect(r.body.manualRequired).toBe(true);
  });

  it('disconnect needs step-up, removes credentials and installations, and is audited', async () => {
    await connectGithub();
    repoFor('GitAppInstallation').rows.push({ id: 'i1', installationId: '1', accountLogin: 'acme', repositorySelection: 'all', repositories: [] });
    expect((await request(app()).delete('/api/settings/integrations/github/app').set(as('admin'))).status).toBe(401);
    const r = await request(app()).delete('/api/settings/integrations/github/app').set(as('admin', true));
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
    expect(repos.GitProviderApp.rows).toHaveLength(0);
    expect(repos.GitAppInstallation.rows).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'settings.git.github.disconnected' }));
  });

  it('unknown providers 404', async () => {
    expect((await request(app()).post('/api/settings/integrations/bitbucket/check').set(as('admin'))).status).toBe(404);
  });
});
