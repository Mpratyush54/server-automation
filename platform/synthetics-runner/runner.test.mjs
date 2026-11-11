// node --test runner.test.mjs (no browser needed: only the pure helpers are tested).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressBlocked, firstDisallowedHop, hopGuard, hostResolverRules, privateIpv4Patterns, redirectChain, render, requestAllowed, runStep,
} from './runner.mjs';

test('blocks internal and non-HTTP requests', () => {
  for (const url of [
    'http://localhost:3000/', 'http://platform-api.platform.svc:3000/api', 'http://10.43.0.1/', 'http://169.254.169.254/latest',
    'http://[::1]/', 'http://[fd00::1]/', 'http://192.168.1.1/', 'file:///etc/passwd', 'ftp://example.com/', 'http://intranet/',
    'https://user:pw@example.com/', 'http://kubernetes.default.svc.cluster.local/',
  ]) assert.equal(requestAllowed(url), false, url);
});

test('allows public pages, inline resources and the project ingress host', () => {
  for (const url of ['https://example.com/', 'http://93.184.216.34/x', 'data:image/png;base64,AAAA', 'about:blank']) {
    assert.equal(requestAllowed(url), true, url);
  }
  assert.equal(requestAllowed('https://app.internal/', ['app.internal']), true);
});

test('renders secrets and leaves unknown names untouched', () => {
  assert.equal(render('pw={{secret.PW}} x={{secret.NOPE}}', { PW: 'p1' }), 'pw=p1 x={{secret.NOPE}}');
});

test('assert_title and assert_url substitute secrets like goto/fill/assert_text', async () => {
  const page = { title: async () => 'Welcome, acme-user', url: () => 'https://app.example.com/t/acme-tenant/home' };
  const secrets = { USER: 'acme-user', TENANT: 'acme-tenant' };
  await runStep(page, { action: 'assert_title', value: 'Welcome, {{secret.USER}}' }, secrets, 1000);
  await runStep(page, { action: 'assert_url', value: '/t/{{secret.TENANT}}/' }, secrets, 1000);
  await assert.rejects(runStep(page, { action: 'assert_title', value: '{{secret.TENANT}}' }, secrets, 1000), (err) => {
    assert.ok(!err.message.includes('acme-tenant'), 'failure message must not contain the rendered secret');
    return true;
  });
});

// A fake Playwright request: url() + redirectedFrom() chain.
const req = (...urls) => urls.reduce((prev, url) => ({ url: () => url, redirectedFrom: () => prev }), null);

test('redirectChain lists every hop oldest first', () => {
  assert.deepEqual(redirectChain(req('https://a.example/', 'https://b.example/', 'https://c.example/')), ['https://a.example/', 'https://b.example/', 'https://c.example/']);
  assert.deepEqual(redirectChain(req('https://a.example/')), ['https://a.example/']);
});

test('firstDisallowedHop rejects a public page that redirects inward', () => {
  for (const target of [
    'http://platform-api.platform.svc:3000/api/health', 'http://10.43.0.10:3000/', 'http://169.254.169.254/latest/meta-data',
    'http://localhost:8080/', 'http://[::1]/', 'file:///etc/passwd', 'http://kubernetes.default.svc.cluster.local/',
  ]) {
    assert.equal(firstDisallowedHop(redirectChain(req('https://public.example/', 'https://public.example/next', target))), target, target);
  }
  assert.equal(firstDisallowedHop(['https://public.example/', 'https://www.public.example/']), null);
  assert.equal(firstDisallowedHop(['https://public.example/', 'https://app.internal/'], ['app.internal']), null);
});

test('hopGuard records disallowed hops once and reports a neutral error', async () => {
  const lookup = async (h) => (h === 'rebind.example' ? [{ address: '10.43.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const g = hopGuard(['app.example.com'], lookup);
  assert.equal(g.check(['https://ok.example/', 'https://ok.example/2']), true);
  assert.equal(g.check(['chrome-error://chromewebdata/']), true, 'browser error pages are not hops');
  assert.equal(await g.resolvesPublic('https://ok.example/'), true);
  assert.equal(await g.resolvesPublic('https://app.example.com/'), true, 'project hosts may resolve privately');
  assert.equal(g.error(), null);
  assert.equal(await g.resolvesPublic('https://rebind.example/', { record: false }), false);
  assert.equal(g.error(), null, 'record:false only answers');
  assert.equal(await g.resolvesPublic('https://rebind.example/x'), false);
  assert.equal(g.check(['https://ok.example/', 'http://10.0.0.5/']), false);
  assert.equal(g.check(['http://10.0.0.5/again']), false);
  assert.equal(g.violations.length, 2);
  assert.match(g.error(), /^navigation to a disallowed target was blocked \(rebind\.example: resolves to a private address\)$/);
});

test('addressBlocked covers private, loopback, link-local and mapped forms', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', 'nonsense']) {
    assert.equal(addressBlocked(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '2606:4700::1111']) assert.equal(addressBlocked(ip), false, ip);
});

test('host resolver rules: project hosts first, then platform domain, internal names and private literals refused', () => {
  const rules = hostResolverRules({ allowedHosts: ['shop.apps.example.com', 'bad host,MAP * 1.2.3.4'], blockedDomains: ['apps.example.com'] }).split(', ');
  assert.equal(rules[0], 'EXCLUDE shop.apps.example.com', 'project host resolves normally without an ingress address');
  assert.ok(!rules.some((r) => r.includes('bad host') || r === 'MAP * 1.2.3.4'), 'invalid host names are dropped');
  assert.ok(rules.indexOf('MAP *.apps.example.com ~NOTFOUND') > 0);
  assert.ok(rules.includes('MAP apps.example.com ~NOTFOUND'));
  for (const r of ['MAP localhost ~NOTFOUND', 'MAP *.svc ~NOTFOUND', 'MAP *.cluster.local ~NOTFOUND', 'MAP 10.*.*.* ~NOTFOUND', 'MAP 169.254.*.* ~NOTFOUND', 'MAP 172.31.*.* ~NOTFOUND', 'MAP 100.127.*.* ~NOTFOUND']) {
    assert.ok(rules.includes(r), r);
  }
  assert.ok(!rules.includes('MAP 172.32.*.* ~NOTFOUND') && !rules.includes('MAP 100.128.*.* ~NOTFOUND'));
  assert.equal(privateIpv4Patterns().length, 5 + 16 + 64 + 32);
});
