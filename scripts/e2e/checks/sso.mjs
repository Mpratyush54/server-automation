// node sso.mjs discovery|grafana|argocd|portainer
// The platform API is the OIDC provider (issuer https://<domain>/api/oauth).
// For each tool this runs a real SSO login as the platform admin:
//   1. the tool's login entry point redirects to the platform authorization
//      endpoint with the tool's client_id and registered redirect URI;
//   2. the provider accepts the request and hands over to the portal consent page;
//   3. the consent call (admin session) returns an authorization code;
//   4. the tool redeems the code (server side, token endpoint) and opens a session.
import { CookieJar, apiUrl, domain, expect, login, main, request, retry } from './common.mjs';

const mode = process.argv[2];
const REDIRECTS = [301, 302, 303, 307, 308];

async function discovery() {
  const issuer = `https://${domain()}/api/oauth`;
  const r = await retry(async () => {
    const res = await request(`${issuer}/.well-known/openid-configuration`);
    if (res.status !== 200 || !res.json) throw new Error(`HTTP ${res.status}`);
    return res;
  }, { attempts: 6 });
  return { d: r.json, issuer };
}

function parse(url, base) { try { return new URL(url, base); } catch { return null; } }

/** Steps 2 and 3: provider hands over to the portal; consent returns the redirect with a code. */
async function authorize(tool, target, adminToken) {
  const D = domain();
  const r = await request(target.href);
  const loc = parse(r.headers.get('location') || '', target.href);
  const toPortal = REDIRECTS.includes(r.status) && loc && loc.origin === `https://${D}` && loc.pathname === '/oauth/authorize';
  expect(toPortal, `${tool}: provider accepts the authorization request`, toPortal ? '' : `HTTP ${r.status}`);
  if (!toPortal) return null;
  const body = Object.fromEntries(target.searchParams);
  const consent = await request(`${apiUrl()}/api/oauth/authorize`, { method: 'POST', body, headers: { authorization: `Bearer ${adminToken}` } });
  const back = consent.status === 200 ? parse(consent.json?.redirect || '') : null;
  const withCode = Boolean(back) && back.searchParams.get('code') && back.href.startsWith(body.redirect_uri);
  expect(withCode, `${tool}: consent issues an authorization code`, withCode ? '' : `HTTP ${consent.status}`);
  return withCode ? back : null;
}

/** Step 1: entry point -> provider, checking client and redirect URI. */
async function entry(tool, url, clientId, redirectUri, jar) {
  const { d } = await discovery();
  const r = await retry(async () => {
    const res = jar.store(await request(url, { headers: { cookie: jar.header() } }));
    if (!REDIRECTS.includes(res.status)) throw new Error(`HTTP ${res.status}`);
    return res;
  }, { attempts: 12 });
  const target = parse(r.headers.get('location') || '', url);
  const toProvider = Boolean(target) && target.href.startsWith(d.authorization_endpoint);
  expect(toProvider, `${tool}: login redirects to the platform authorization endpoint`, toProvider ? '' : `HTTP ${r.status}`);
  if (!toProvider) return null;
  const q = target.searchParams;
  expect(q.get('client_id') === clientId, `${tool}: client_id is ${clientId}`, 'unexpected client');
  expect(q.get('response_type') === 'code', `${tool}: authorization code flow`, `response_type=${q.get('response_type')}`);
  expect(q.get('redirect_uri') === redirectUri, `${tool}: registered redirect URI`, 'unexpected redirect_uri');
  return target;
}

async function cookieFlow(tool, entryUrl, clientId, redirectUri, sessionCookie) {
  const jar = new CookieJar();
  const target = await entry(tool, entryUrl, clientId, redirectUri, jar);
  if (!target) return;
  const back = await authorize(tool, target, await login());
  if (!back) return;
  // Step 4: the callback redeems the code and must set the tool's session cookie.
  const cb = jar.store(await request(back.href, { headers: { cookie: jar.header() }, timeoutMs: 30000 }));
  const loc = cb.headers.get('location') || '';
  const session = REDIRECTS.includes(cb.status) && jar.has(sessionCookie) && !/error|\/login(\?|$)/i.test(loc);
  expect(session, `${tool}: SSO login completes with a session`, session ? '' : `HTTP ${cb.status}`);
}

async function portainer() {
  const D = domain();
  const { d } = await discovery();
  const r = await retry(async () => {
    const res = await request(`https://portainer.${D}/api/settings/public`);
    if (res.status !== 200 || !res.json) throw new Error(`HTTP ${res.status}`);
    return res;
  }, { attempts: 12 });
  const target = parse(r.json.OAuthLoginURI || '');
  const toProvider = Boolean(target) && target.href.startsWith(d.authorization_endpoint);
  expect(toProvider, 'Portainer: OAuth login points at the platform authorization endpoint', 'not configured');
  if (!toProvider) return;
  expect(target.searchParams.get('client_id') === 'portainer', 'Portainer: client_id is portainer', 'unexpected client');
  expect(target.searchParams.get('redirect_uri') === `https://portainer.${D}/`, 'Portainer: registered redirect URI', 'unexpected redirect_uri');
  if (!target.searchParams.get('state')) target.searchParams.set('state', 'e2e');
  const back = await authorize('Portainer', target, await login());
  if (!back) return;
  // Portainer's web UI posts the code to its API, which redeems it server side.
  const v = await request(`https://portainer.${D}/api/auth/oauth/validate`, { method: 'POST', body: { code: back.searchParams.get('code') }, timeoutMs: 30000 });
  expect(v.status === 200 && typeof v.json?.jwt === 'string', 'Portainer: SSO login completes with a session', `HTTP ${v.status}`);
}

await main(async () => {
  const D = domain();
  if (mode === 'discovery') {
    const { d, issuer } = await discovery();
    expect(d.issuer === issuer, 'OIDC issuer matches', 'issuer mismatch');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      expect(typeof d[k] === 'string' && d[k].startsWith(`https://${D}/`), `OIDC ${k} on the platform host`, 'missing or foreign');
    }
    const jwks = await request(d.jwks_uri);
    expect(jwks.status === 200 && Array.isArray(jwks.json?.keys) && jwks.json.keys.length > 0, 'OIDC JWKS publishes signing keys', `HTTP ${jwks.status}`);
  } else if (mode === 'grafana') {
    await cookieFlow('Grafana', `https://${D}/grafana/login/generic_oauth`, 'grafana', `https://${D}/grafana/login/generic_oauth`, 'grafana_session');
  } else if (mode === 'argocd') {
    await cookieFlow('Argo CD', `https://${D}/argocd/auth/login?return_url=${encodeURIComponent(`https://${D}/argocd/applications`)}`, 'argocd', `https://${D}/argocd/auth/callback`, 'argocd.token');
  } else if (mode === 'portainer') {
    await portainer();
  } else {
    throw new Error('usage: sso.mjs discovery|grafana|argocd|portainer');
  }
});
