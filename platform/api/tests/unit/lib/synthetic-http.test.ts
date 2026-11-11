/**
 * Synthetic HTTP client against a local server. The SSRF guard is replaced by a fake that
 * maps test host names to 127.0.0.1 (the real guard refuses loopback), so these tests
 * prove the client connects to the address the guard returned, re-validates every redirect
 * hop, and enforces the caps.
 */
import http from 'http';
import { AddressInfo } from 'net';

const mockResolve = jest.fn();
jest.mock('../../../src/lib/synthetic-ssrf', () => {
  const actual = jest.requireActual('../../../src/lib/synthetic-ssrf');
  return { ...actual, resolveTarget: (...args: any[]) => mockResolve(...args) };
});

import tls from 'tls';
import { syntheticHttpRequest, trustFor, USER_AGENT } from '../../../src/lib/synthetic-http';
import { SsrfError } from '../../../src/lib/synthetic-ssrf';

let server: http.Server;
let port: number;
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; method: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url || '', headers: req.headers, method: req.method || '' });
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/ok') { res.setHeader('X-Test', 'yes'); res.end('{"status":"ok"}'); return; }
    if (u.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', '/ok'); res.end(); return; }
    if (u.pathname === '/cross') { res.statusCode = 302; res.setHeader('Location', `http://other.test:${port}/ok`); res.end(); return; }
    if (u.pathname === '/internal') { res.statusCode = 302; res.setHeader('Location', 'http://internal.test/'); res.end(); return; }
    if (u.pathname === '/to-private') { res.statusCode = 302; res.setHeader('Location', 'http://10.43.0.10:3000/'); res.end(); return; }
    if (u.pathname === '/to-svc') { res.statusCode = 302; res.setHeader('Location', 'http://platform-api.platform.svc:3000/api'); res.end(); return; }
    if (u.pathname === '/to-metadata') { res.statusCode = 302; res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/'); res.end(); return; }
    if (u.pathname === '/loop') { res.statusCode = 302; res.setHeader('Location', '/loop'); res.end(); return; }
    if (u.pathname === '/post303') { res.statusCode = 303; res.setHeader('Location', '/ok'); res.end(); return; }
    if (u.pathname === '/big') { res.write('x'.repeat(1024 * 1024)); res.end('y'.repeat(4096)); return; }
    if (u.pathname === '/slow') { setTimeout(() => res.end('late'), 2_000); return; }
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

beforeEach(() => {
  seen.length = 0;
  mockResolve.mockReset();
  mockResolve.mockImplementation(async (raw: string) => {
    const url = new URL(raw);
    if (url.hostname === 'internal.test') throw new SsrfError('internal.test resolves to a private address', 'private_address');
    return { url, hostname: url.hostname, port: Number(url.port) || 80, address: '127.0.0.1', family: 4, ingressException: false };
  });
});

const base = () => `http://app.test:${port}`;

it('connects to the guard-validated address (the host name itself is not resolvable)', async () => {
  const r = await syntheticHttpRequest({ method: 'GET', url: `${base()}/ok`, timeoutMs: 3000 });
  expect(r.status).toBe(200);
  expect(r.body).toBe('{"status":"ok"}');
  expect(r.headers['x-test']).toBe('yes');
  expect(r.address).toBe('127.0.0.1');
  expect(seen[0].headers.host).toBe(`app.test:${port}`);
  expect(seen[0].headers['user-agent']).toBe(USER_AGENT);
  expect(seen[0].headers.cookie).toBeUndefined();
  expect(seen[0].headers.authorization).toBeUndefined();
});

it('follows redirects, re-validating every hop', async () => {
  const r = await syntheticHttpRequest({ method: 'GET', url: `${base()}/redirect`, timeoutMs: 3000 });
  expect(r).toMatchObject({ status: 200, redirects: 1 });
  expect(mockResolve).toHaveBeenCalledTimes(2);
});

it('refuses a redirect to an internal target', async () => {
  await expect(syntheticHttpRequest({ method: 'GET', url: `${base()}/internal`, timeoutMs: 3000 })).rejects.toMatchObject({ code: 'private_address' });
});

it('caps redirects', async () => {
  await expect(syntheticHttpRequest({ method: 'GET', url: `${base()}/loop`, timeoutMs: 3000, maxRedirects: 2 })).rejects.toMatchObject({ code: 'redirects' });
  expect(seen.length).toBe(3);
});

it('does not follow redirects when disabled', async () => {
  const r = await syntheticHttpRequest({ method: 'GET', url: `${base()}/redirect`, timeoutMs: 3000, followRedirects: false });
  expect(r.status).toBe(302);
});

it('drops check headers on a cross-origin redirect', async () => {
  await syntheticHttpRequest({ method: 'GET', url: `${base()}/cross`, headers: { Authorization: 'Bearer t0k3n', 'X-Api-Key': 'k' }, timeoutMs: 3000 });
  expect(seen[0].headers.authorization).toBe('Bearer t0k3n');
  expect(seen[1].headers.host).toBe(`other.test:${port}`);
  expect(seen[1].headers.authorization).toBeUndefined();
  expect(seen[1].headers['x-api-key']).toBeUndefined();
});

it('303 after POST becomes GET without a body', async () => {
  await syntheticHttpRequest({ method: 'POST', url: `${base()}/post303`, body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, timeoutMs: 3000 });
  expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
  expect(seen[1].headers['content-type']).toBeUndefined();
});

it('truncates large bodies at the cap', async () => {
  const r = await syntheticHttpRequest({ method: 'GET', url: `${base()}/big`, timeoutMs: 5000, maxBodyBytes: 1000 });
  expect(r.truncated).toBe(true);
  expect(r.body.length).toBe(1000);
});

it('times out', async () => {
  await expect(syntheticHttpRequest({ method: 'GET', url: `${base()}/slow`, timeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout' });
});

describe('platform hosts (#152)', () => {
  const actual = jest.requireActual('../../../src/lib/synthetic-ssrf');
  // api.apps.example.com stands in for a platform host (pinned to the local server);
  // every other hop goes through the REAL guard with the platform domain configured.
  const guard = { platformDomain: 'apps.example.com', ingressResolver: async () => ['10.43.12.7'] };
  beforeEach(() => {
    mockResolve.mockImplementation(async (raw: string, g: any) => {
      const url = new URL(raw);
      if (url.hostname === 'api.apps.example.com') {
        return { url, hostname: url.hostname, port: Number(url.port) || 80, address: '127.0.0.1', family: 4, ingressException: true, platformHost: true };
      }
      return actual.resolveTarget(raw, g);
    });
  });

  it.each(['/to-private', '/to-svc', '/to-metadata'])('a redirect from a platform host to an internal target is refused (%s)', async (path) => {
    await expect(syntheticHttpRequest({ method: 'GET', url: `http://api.apps.example.com:${port}${path}`, timeoutMs: 3000 }, guard))
      .rejects.toBeInstanceOf(SsrfError);
    expect(mockResolve).toHaveBeenCalledTimes(2);
  });

  it('the platform CA is added to the public roots for platform hosts only', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const trust = trustFor({ platformHost: true }, ca);
    expect(trust).toHaveLength(tls.rootCertificates.length + 1);
    expect(trust![trust!.length - 1]).toBe(ca);
    expect(trustFor({ platformHost: false }, ca)).toBeUndefined();
    expect(trustFor({ platformHost: true }, null)).toBeUndefined();
  });
});
