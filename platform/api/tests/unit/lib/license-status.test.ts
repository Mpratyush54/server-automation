import express from 'express';
import request from 'supertest';

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
let mockRole = 'admin';
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, _res: any, next: any) => { req.user = { id: 'u', role: mockRole }; next(); },
  expressRequireRole: (roles: string[]) => (req: any, res: any, next: any) =>
    req.user.role === 'admin' || roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }),
}));

import { parseLicenseStatus } from '../../../src/lib/license-status';
import licenseRoutes, { deps } from '../../../src/routes/license';

const app = express();
app.use(licenseRoutes);

const report = JSON.stringify({
  command: 'checkin', status: 'valid', exit_code: 0, plan: 'personal', org: 'Acme', max_nodes: 3, max_installs: 2,
  expires_at: '2027-01-01T00:00:00Z', grace_until: '2027-02-01T00:00:00Z', last_checkin: '2026-11-10T00:00:00Z',
  updated_at: '2026-11-10T00:00:01Z', enforce: true, install_id: 'ins_secret', file: '/etc/platform/license.json',
});

describe('parseLicenseStatus', () => {
  it('returns whitelisted fields only', () => {
    const s = parseLicenseStatus(report);
    expect(s).toEqual({
      available: true, status: 'valid', state: 'valid', plan: 'personal', org: 'Acme', maxNodes: 3, maxInstalls: 2,
      expiresAt: '2027-01-01T00:00:00.000Z', graceUntil: '2027-02-01T00:00:00.000Z', lastCheckin: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:01.000Z', enforce: true,
    });
    expect(JSON.stringify(s)).not.toContain('ins_secret');
  });

  it.each([[10, 'attention'], [20, 'invalid'], [30, 'invalid']])('maps exit %s to %s', (code, state) => {
    expect(parseLicenseStatus(JSON.stringify({ exit_code: code })).state).toBe(state);
  });

  it('handles missing and malformed data', () => {
    expect(parseLicenseStatus(null).available).toBe(false);
    expect(parseLicenseStatus('{').available).toBe(false);
    const s = parseLicenseStatus(JSON.stringify({ plan: '<script>', max_nodes: -1, expires_at: 'soon', enforce: 'yes' }));
    expect(s).toMatchObject({ plan: null, maxNodes: null, expiresAt: null, enforce: false, state: 'unknown' });
  });
});

describe('GET /license', () => {
  afterEach(() => { mockRole = 'admin'; });

  it('returns the cached status to admins', async () => {
    deps.read = async () => report;
    const res = await request(app).get('/license');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, plan: 'personal', enforce: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports no status when the ConfigMap is missing', async () => {
    deps.read = async () => null;
    const res = await request(app).get('/license');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('is admin only', async () => {
    mockRole = 'devops';
    expect((await request(app).get('/license')).status).toBe(403);
  });
});
