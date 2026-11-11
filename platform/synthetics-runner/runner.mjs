// Browser synthetic check runner (#42). Runs as a Kubernetes CronJob in the
// `synthetics` namespace: fetch the check definition from the platform API with the
// per-check run token, drive headless Chromium through the declared steps (no
// arbitrary scripts), and report the result (+ a PNG screenshot on failure).
//
// Network safety (layered):
//   1. The pod's egress NetworkPolicy allows the public internet, cluster DNS and the
//      platform API's dedicated runner port only.
//   2. Chromium's host resolver refuses cluster-internal names, the platform's own
//      domain and literal private addresses on EVERY connection, redirect hops included.
//   3. Requests the page issues are checked here before they leave (scheme, host,
//      resolved addresses); redirect hops, which Playwright cannot hold back, are
//      re-validated as they happen and after every step; any disallowed hop fails the
//      check and no screenshot of the resulting page is taken.
import dns from 'node:dns';
import net from 'node:net';

const API = (process.env.PLATFORM_API_URL || 'http://platform-api-synthetics.platform.svc:3001').replace(/\/+$/, '');
const CHECK_ID = process.env.CHECK_ID || '';
const TOKEN = process.env.RUN_TOKEN || '';
const USER_AGENT_SUFFIX = ' platform-synthetics/1.0';

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const blocked = new net.BlockList();
for (const [a, p] of PRIVATE_V4) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');
const INTERNAL = ['localhost', '.localhost', '.local', '.internal', '.svc', '.cluster.local'];

export function requestAllowed(rawUrl, allowedHosts = []) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts.includes(host)) return true;
  if (INTERNAL.some((s) => host === s.replace(/^\./, '') || host.endsWith(s))) return false;
  const fam = net.isIP(host);
  if (fam === 4 && blocked.check(host, 'ipv4')) return false;
  if (fam === 6 && (blocked.check(host, 'ipv6') || /^::ffff:/i.test(host) || /^64:ff9b::/i.test(host))) return false; // mapped / NAT64 forms refused
  if (fam === 0 && !host.includes('.')) return false;
  return true;
}

/** Whether an address is one the runner must never connect to (private, loopback, link-local, ...). */
export function addressBlocked(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) return blocked.check(ip, 'ipv6') || /^::ffff:/i.test(ip) || /^64:ff9b::/i.test(ip) || /^::(\d|$)/.test(ip);
  return true;
}

/** URLs of a request and every hop before it, oldest first (Playwright `redirectedFrom()` chain). */
export function redirectChain(request) {
  const urls = [];
  for (let r = request; r && urls.length < 50; r = typeof r.redirectedFrom === 'function' ? r.redirectedFrom() : null) urls.unshift(r.url());
  return urls;
}

/** First URL in a hop chain that fails the request rules, or null. */
export function firstDisallowedHop(urls, allowedHosts = []) {
  return urls.find((u) => !requestAllowed(u, allowedHosts)) ?? null;
}

/** Wildcard patterns covering the literal private IPv4 ranges (Chromium host-resolver-rules syntax). */
export function privateIpv4Patterns() {
  // Four labels, so ordinary names such as 10.example.com are not caught.
  const out = ['0.*.*.*', '10.*.*.*', '127.*.*.*', '169.254.*.*', '192.168.*.*'];
  for (let b = 16; b <= 31; b++) out.push(`172.${b}.*.*`);
  for (let b = 64; b <= 127; b++) out.push(`100.${b}.*.*`);
  for (let a = 224; a <= 255; a++) out.push(`${a}.*.*.*`);
  return out;
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const validHostname = (h) => typeof h === 'string' && HOST_RE.test(h);

/**
 * Chromium --host-resolver-rules: the first matching rule wins, so the project's own
 * hosts come first (mapped to `ingressIp` when known, else resolved normally), then
 * the platform's domains, cluster-internal suffixes and private literal addresses are
 * refused. These rules apply to every connection the browser makes, redirects included.
 */
export function hostResolverRules({ allowedHosts = [], ingressIp = null, blockedDomains = [] } = {}) {
  const rules = [];
  const allowed = allowedHosts.map((h) => String(h).toLowerCase()).filter(validHostname);
  const mapTo = ingressIp && net.isIPv4(ingressIp) ? ingressIp : null;
  for (const h of allowed) rules.push(mapTo ? `MAP ${h} ${mapTo}` : `EXCLUDE ${h}`);
  for (const d of blockedDomains.map((x) => String(x).toLowerCase()).filter(validHostname)) {
    rules.push(`MAP ${d} ~NOTFOUND`, `MAP *.${d} ~NOTFOUND`);
  }
  rules.push('MAP localhost ~NOTFOUND');
  for (const sfx of INTERNAL) if (sfx.startsWith('.')) rules.push(`MAP *${sfx} ~NOTFOUND`);
  for (const p of privateIpv4Patterns()) rules.push(`MAP ${p} ~NOTFOUND`);
  return rules.join(', ');
}

/**
 * Tracks hop violations for one browser context. `check(urls)` applies the request
 * rules synchronously; `resolvesPublic(url)` adds a DNS check so a public-looking name
 * that resolves to a private address is caught as well.
 */
export function hopGuard(allowedHosts = [], lookup = (h) => dns.promises.lookup(h, { all: true, verbatim: true })) {
  const violations = [];
  const cache = new Map();
  const note = (url, reason) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* unparsable */ }
    if (!violations.some((v) => v.host === host)) violations.push({ host, reason });
  };
  return {
    violations,
    /** Record a disallowed hop; browser error pages (failed loads) are not hops. */
    check(urls) {
      const bad = firstDisallowedHop(urls.filter((u) => !String(u).startsWith('chrome-error:')), allowedHosts);
      if (bad) note(bad, 'disallowed target');
      return !bad;
    },
    async resolvesPublic(rawUrl, { record = true } = {}) {
      let u;
      try { u = new URL(rawUrl); } catch { return false; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (allowedHosts.includes(host) || net.isIP(host)) return true; // literals: requestAllowed already decided
      if (!cache.has(host)) {
        cache.set(host, Promise.resolve().then(() => lookup(host)).then(
          (addrs) => !Array.isArray(addrs) || addrs.every((a) => !addressBlocked(a.address)),
          () => true, // unresolvable here: the browser cannot connect either
        ));
      }
      const ok = await cache.get(host);
      if (!ok && record) note(rawUrl, 'resolves to a private address');
      return ok;
    },
    error() {
      if (violations.length === 0) return null;
      const v = violations[0];
      return `navigation to a disallowed target was blocked (${v.host || 'unknown host'}: ${v.reason})`;
    },
  };
}

export function render(value, secrets) {
  return String(value ?? '').replace(/\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g, (whole, name) =>
    (Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : whole));
}

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const v of Object.values(secrets)) if (typeof v === 'string' && v.length >= 4) out = out.split(v).join('[redacted]');
  return out.slice(0, 1000);
}

function describe(step) {
  return [step.action, step.selector, step.action === 'goto' ? step.url : null].filter(Boolean).join(' ').slice(0, 100);
}

export async function runStep(page, step, secrets, timeout) {
  switch (step.action) {
    case 'goto': {
      const res = await page.goto(render(step.url, secrets), { timeout, waitUntil: 'load' });
      if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
      return;
    }
    case 'click': return page.locator(step.selector).first().click({ timeout });
    case 'fill': return page.locator(step.selector).first().fill(render(step.value, secrets), { timeout });
    case 'press': return page.locator(step.selector).first().press(step.value, { timeout });
    case 'wait_for': return page.locator(step.selector).first().waitFor({ state: 'visible', timeout });
    case 'assert_text': {
      const text = await page.locator(step.selector).first().innerText({ timeout });
      if (!text.includes(render(step.value, secrets))) throw new Error(`text of ${step.selector} does not contain the expected value`);
      return;
    }
    case 'assert_title': {
      const title = await page.title();
      // Messages carry the template, never the rendered value (it may contain a secret).
      if (!title.includes(render(step.value, secrets))) throw new Error(`title "${title.slice(0, 100)}" does not contain "${step.value}"`);
      return;
    }
    case 'assert_url': {
      if (!page.url().includes(render(step.value, secrets))) throw new Error(`URL does not contain "${step.value}"`);
      return;
    }
    case 'wait': return page.waitForTimeout(Math.min(30_000, Number(step.ms) || 0));
    default: throw new Error(`unknown action ${step.action}`);
  }
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`platform API ${path}: HTTP ${res.status}`);
  return res.json();
}

export async function main() {
  if (!CHECK_ID || !TOKEN) throw new Error('CHECK_ID and RUN_TOKEN are required');
  const def = await api(`/api/synthetics/runner/checks/${CHECK_ID}`);
  if (!def.enabled) { console.log('check disabled; nothing to do'); return; }
  const secrets = def.secrets || {};
  const allowed = (def.allowedIngressHosts || []).map((h) => String(h).toLowerCase());
  const blockedDomains = (def.blockedDomains || []).map((h) => String(h).toLowerCase());
  const startedAt = new Date();
  const deadline = Date.now() + (Number(def.timeoutMs) || 60_000);
  const steps = [];
  let status = 'pass';
  let error = null;
  let screenshot = null;
  const guard = hopGuard(allowed);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      `--host-resolver-rules=${hostResolverRules({ allowedHosts: allowed, blockedDomains })}`,
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
    const ua = await (await context.newPage()).evaluate(() => navigator.userAgent).catch(() => '');
    await context.close();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block', userAgent: `${ua}${USER_AGENT_SUFFIX}` });
    // Requests the page starts: validated (rules + resolved addresses) before they are
    // sent and aborted when disallowed (a blocked sub-resource does not fail the check).
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      const ok = firstDisallowedHop(redirectChain(route.request()), allowed) === null && await guard.resolvesPublic(url, { record: false });
      return ok ? route.continue() : route.abort('blockedbyclient');
    });
    // Redirect hops are followed by the browser without reaching the route handler:
    // re-validate each one as it is issued (the resolver rules above refuse internal
    // targets at connect time; this records the violation and fails the check).
    ctx.on('request', (request) => {
      if (!request.redirectedFrom()) return;
      if (guard.check(redirectChain(request))) guard.resolvesPublic(request.url()).catch(() => {});
    });
    ctx.on('response', (response) => { guard.check(redirectChain(response.request())); });
    const page = await ctx.newPage();
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) guard.check([frame.url()]); });
    const assertHops = async () => {
      guard.check([page.url()]);
      await guard.resolvesPublic(page.url());
      const msg = guard.error();
      if (msg) throw new Error(msg);
    };
    for (const step of def.steps || []) {
      const name = describe(step);
      if (status === 'fail') { steps.push({ name, status: 'skipped' }); continue; }
      const t0 = Date.now();
      const remaining = deadline - t0;
      try {
        if (remaining <= 0) throw new Error('check timeout');
        try {
          await runStep(page, step, secrets, Math.min(remaining, 30_000));
        } catch (err) {
          await assertHops(); // a blocked hop explains the failure better than the step error
          throw err;
        }
        await assertHops();
        steps.push({ name, status: 'pass', latencyMs: Date.now() - t0 });
      } catch (err) {
        status = 'fail';
        error = redact(`${name}: ${err?.message || err}`, secrets);
        steps.push({ name, status: 'fail', latencyMs: Date.now() - t0, error: redact(err?.message || err, secrets) });
      }
    }
    // Never capture a page reached through a disallowed hop.
    if (status === 'fail' && guard.violations.length === 0) {
      try { screenshot = (await page.screenshot({ type: 'png', timeout: 10_000 })).toString('base64'); } catch { /* best effort */ }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const latencyMs = Date.now() - startedAt.getTime();
  const out = await api(`/api/synthetics/runner/checks/${CHECK_ID}/results`, {
    method: 'POST',
    body: JSON.stringify({ status, latencyMs, error, steps, startedAt: startedAt.toISOString(), ...(screenshot ? { screenshot } : {}) }),
  });
  console.log(`result ${out.status} (${latencyMs} ms)${out.screenshotStored ? ', screenshot stored' : ''}`);
}

if (/runner.mjs$/.test(process.argv[1] || '')) {
  main().catch((err) => {
    console.error(`synthetics runner failed: ${redact(err?.message || err, {})}`);
    process.exit(1);
  });
}
