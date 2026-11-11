// node --test runner.test.mjs (no browser needed: only the pure helpers are tested).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressBlocked, firstDisallowedHop, hopGuard, hostResolverRules, isPlatformHost, nssTrustCommands, platformDomains, privateIpv4Patterns,
  redirectChain, render, requestAllowed, resolveIngressAddress, runStep,
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

test('host resolver rules: project hosts first, internal names and private literals refused', () => {
  const rules = hostResolverRules({ allowedHosts: ['shop.apps.example.com', 'bad host,MAP * 1.2.3.4'] }).split(', ');
  assert.equal(rules[0], 'EXCLUDE shop.apps.example.com', 'project host resolves normally without an ingress address');
  assert.ok(!rules.some((r) => r.includes('bad host') || r === 'MAP * 1.2.3.4'), 'invalid host names are dropped');
  for (const r of ['MAP localhost ~NOTFOUND', 'MAP *.svc ~NOTFOUND', 'MAP *.cluster.local ~NOTFOUND', 'MAP 10.*.*.* ~NOTFOUND', 'MAP 169.254.*.* ~NOTFOUND', 'MAP 172.31.*.* ~NOTFOUND', 'MAP 100.127.*.* ~NOTFOUND']) {
    assert.ok(rules.includes(r), r);
  }
  assert.ok(!rules.includes('MAP 172.32.*.* ~NOTFOUND') && !rules.includes('MAP 100.128.*.* ~NOTFOUND'));
  assert.equal(privateIpv4Patterns().length, 5 + 16 + 64 + 32);
});

test('env hosts: exactly the project hosts are mapped to the ingress controller', () => {
  const rules = hostResolverRules({ allowedHosts: ['shop.customer.example', 'shop-staging.customer.example'], ingressIp: '10.43.12.7' }).split(', ');
  assert.deepEqual(rules.slice(0, 2), ['MAP shop.customer.example 10.43.12.7', 'MAP shop-staging.customer.example 10.43.12.7']);
  assert.ok(!rules.some((r) => r.startsWith('MAP *') && r.endsWith('10.43.12.7')), 'no wildcard without a platform domain');
  // A non-IPv4 ingress answer is never used as a mapping target.
  assert.equal(hostResolverRules({ allowedHosts: ['a.example.com'], ingressIp: 'evil.example' }).split(', ')[0], 'EXCLUDE a.example.com');
});

test('platform domain: DOMAIN and *.DOMAIN are mapped to the ingress controller, never blocked or resolved elsewhere (#152)', () => {
  const rules = hostResolverRules({ allowedHosts: ['shop.apps.example.com'], ingressIp: '10.43.12.7', ingressDomains: ['apps.example.com'] }).split(', ');
  assert.deepEqual(rules.slice(0, 3), ['MAP shop.apps.example.com 10.43.12.7', 'MAP apps.example.com 10.43.12.7', 'MAP *.apps.example.com 10.43.12.7']);
  assert.ok(!rules.some((r) => r.includes('apps.example.com ~NOTFOUND')), 'no block rule for platform hosts');
  assert.ok(!rules.some((r) => r.startsWith('EXCLUDE') && r.includes('apps.example.com') && r !== 'EXCLUDE shop.apps.example.com'));
  // Platform rules come before the internal-name / private-literal refusals.
  assert.ok(rules.indexOf('MAP *.apps.example.com 10.43.12.7') < rules.indexOf('MAP *.svc ~NOTFOUND'));
  assert.ok(rules.includes('MAP *.svc ~NOTFOUND') && rules.includes('MAP 10.*.*.* ~NOTFOUND'));
  // A .local platform domain (LAN installs) still maps to the ingress before *.local is refused.
  const lan = hostResolverRules({ ingressIp: '10.43.12.7', ingressDomains: ['platform.local'] }).split(', ');
  assert.ok(lan.indexOf('MAP *.platform.local 10.43.12.7') < lan.indexOf('MAP *.local ~NOTFOUND'));
});

test('platform domain without a known ingress address is refused, not resolved', () => {
  const rules = hostResolverRules({ ingressDomains: ['apps.example.com'] }).split(', ');
  assert.deepEqual(rules.slice(0, 2), ['MAP apps.example.com ~NOTFOUND', 'MAP *.apps.example.com ~NOTFOUND']);
  assert.ok(!rules.some((r) => r.startsWith('EXCLUDE')));
});

test('platform domains: cluster-internal or malformed values are ignored', () => {
  assert.deepEqual(platformDomains(['Apps.Example.com.', 'apps.example.com', 'svc', 'cluster.local', 'default.svc.cluster.local', 'x.svc',
    'localhost', 'com', '10.0.0.1', 'bad host', 'MAP * 1.2.3.4']), ['apps.example.com']);
  assert.deepEqual(platformDomains('apps.example.com'), []);
  const rules = hostResolverRules({ ingressIp: '10.43.12.7', ingressDomains: ['cluster.local', 'svc'] }).split(', ');
  assert.ok(!rules.some((r) => r.endsWith('10.43.12.7')), 'an internal "domain" never maps cluster names to the ingress');
});

test('request rules: platform hosts allowed, other internal targets still refused', () => {
  const domains = ['apps.example.com'];
  for (const url of ['https://apps.example.com/', 'https://api.apps.example.com/v1', 'http://grafana.apps.example.com/login']) {
    assert.equal(requestAllowed(url, [], domains), true, url);
    assert.equal(requestAllowed(url), true, `${url} (no domain: public-looking name, DNS check decides)`);
  }
  for (const url of ['http://10.43.0.1/', 'http://169.254.169.254/latest', 'http://platform-api.platform.svc:3000/', 'http://kubernetes.default.svc.cluster.local/',
    'http://localhost/', 'https://user:pw@apps.example.com/', 'ftp://apps.example.com/']) {
    assert.equal(requestAllowed(url, [], domains), false, url);
  }
  assert.equal(isPlatformHost('evilapps.example.com', domains), false, 'suffix must be a label boundary');
  assert.equal(isPlatformHost('apps.example.com.evil.example', domains), false);
  // Redirect from a platform host to a private / cluster target is still refused.
  for (const target of ['http://10.43.0.10:3000/', 'http://169.254.169.254/latest/meta-data', 'http://platform-api.platform.svc:3000/api/health', 'http://192.168.1.1/']) {
    assert.equal(firstDisallowedHop(['https://apps.example.com/', 'https://api.apps.example.com/next', target], [], domains), target, target);
  }
  assert.equal(firstDisallowedHop(['https://public.example/', 'https://apps.example.com/', 'https://api.apps.example.com/'], [], domains), null);
});

test('hopGuard: platform hosts skip the DNS check (pinned to the ingress), others do not', async () => {
  const lookup = async () => [{ address: '10.43.12.7', family: 4 }];
  const g = hopGuard([], lookup, ['apps.example.com']);
  assert.equal(await g.resolvesPublic('https://api.apps.example.com/'), true);
  assert.equal(await g.resolvesPublic('https://apps.example.com/'), true);
  assert.equal(g.check(['https://apps.example.com/', 'https://api.apps.example.com/']), true);
  assert.equal(await g.resolvesPublic('https://other.example/'), false);
  assert.equal(g.check(['https://apps.example.com/', 'http://10.0.0.5/']), false);
  assert.match(g.error(), /other\.example: resolves to a private address/);
});

test('resolveIngressAddress returns an IPv4 address or null', async () => {
  assert.equal(await resolveIngressAddress('ingress', async () => ({ address: '10.43.12.7', family: 4 })), '10.43.12.7');
  assert.equal(await resolveIngressAddress('ingress', async () => { throw new Error('ENOTFOUND'); }), null);
  assert.equal(await resolveIngressAddress('ingress', async () => ({ address: 'fd00::1', family: 6 })), null);
  assert.equal(await resolveIngressAddress('', async () => ({ address: '10.0.0.1' })), null);
});

test('platform CA is added to the run profile NSS db for TLS servers only', () => {
  const cmds = nssTrustCommands('/tmp', '/etc/platform-ca/ca.crt');
  assert.deepEqual(cmds[0], ['certutil', ['-d', 'sql:/tmp/.pki/nssdb', '-N', '--empty-password']]);
  assert.deepEqual(cmds[1], ['certutil', ['-d', 'sql:/tmp/.pki/nssdb', '-A', '-t', 'C,,', '-n', 'platform-internal-ca', '-i', '/etc/platform-ca/ca.crt']]);
});
