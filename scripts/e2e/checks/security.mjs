// node security.mjs unauth|headers
// Generic security regression probes. The probe list lives here, not in the
// workflow; the job log only shows pass/fail per group.
import { apiUrl, bad, domain, expect, main, ok, request } from './common.mjs';

const mode = process.argv[2];

// Endpoints that must never answer without valid credentials.
const PROTECTED = [
  ['GET', '/api/users'],
  ['GET', '/api/users/me'],
  ['GET', '/api/audit-logs'],
  ['GET', '/api/settings/backups'],
  ['GET', '/api/operations'],
  ['GET', '/api/agent-tokens/me'],
  ['GET', '/api/db-connections'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['GET', '/api/alerts'],
  ['GET', '/api/notifications'],
  ['GET', '/api/roles'],
  ['GET', '/api/sdk/db-credentials?projectId=e2e-probe'],
  ['POST', '/api/sdk/api-metrics'],
];

const CREDENTIALS = [
  ['no credentials', {}],
  ['malformed bearer token', { authorization: 'Bearer not-a-token' }],
  ['forged unsigned JWT', { authorization: `Bearer ${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"admin","role":"admin"}').toString('base64url')}.` }],
];

async function unauth() {
  for (const [label, headers] of CREDENTIALS) {
    const failures = [];
    for (const [method, path] of PROTECTED) {
      const r = await request(`${apiUrl()}${path}`, { method, headers, body: method === 'POST' ? {} : undefined });
      if (r.status !== 401 && r.status !== 403) failures.push(`${method} ${path} -> ${r.status}`);
    }
    if (failures.length === 0) ok(`protected endpoints reject ${label} (${PROTECTED.length} endpoints)`);
    else bad(`protected endpoints reject ${label}`, `${failures.length} endpoint(s) answered: ${failures.join(', ')}`);
  }
}

function header(r, name) { return r.headers.get(name) || ''; }

async function headers() {
  const api = await request(`${apiUrl()}/api/health`);
  expect(header(api, 'x-content-type-options').toLowerCase() === 'nosniff', 'API: X-Content-Type-Options nosniff', 'missing');
  expect(/max-age=\d+/.test(header(api, 'strict-transport-security')), 'API: Strict-Transport-Security', 'missing');
  expect(Boolean(header(api, 'x-frame-options')) || /frame-ancestors/.test(header(api, 'content-security-policy')), 'API: framing restricted', 'missing');
  expect(!header(api, 'x-powered-by'), 'API: no X-Powered-By', 'present');

  const portal = await request(`https://${domain()}/`);
  expect(/default-src/.test(header(portal, 'content-security-policy')), 'portal: Content-Security-Policy', 'missing');
  expect(Boolean(header(portal, 'x-frame-options')) || /frame-ancestors/.test(header(portal, 'content-security-policy')), 'portal: framing restricted', 'missing');
  expect(header(portal, 'x-content-type-options').toLowerCase() === 'nosniff', 'portal: X-Content-Type-Options nosniff', 'missing');
  expect(Boolean(header(portal, 'referrer-policy')), 'portal: Referrer-Policy', 'missing');

  for (const host of [domain(), `api.${domain()}`]) {
    const r = await request(`http://${host}/`);
    const loc = header(r, 'location');
    expect([301, 302, 307, 308].includes(r.status) && loc.startsWith(`https://${host}`), `${host}: plain HTTP redirects to HTTPS`, `HTTP ${r.status}`);
  }

  // Error responses must not leak stack traces.
  const notFound = await request(`${apiUrl()}/api/e2e-does-not-exist`);
  expect(notFound.status === 404 && !/\bat \S+ \(.*:\d+:\d+\)/.test(notFound.text), 'API: 404 without stack trace', `HTTP ${notFound.status}`);
}

await main(async () => {
  if (mode === 'unauth') await unauth();
  else if (mode === 'headers') await headers();
  else throw new Error('usage: security.mjs unauth|headers');
});
