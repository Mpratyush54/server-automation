// Browser synthetic check runner (#42). Runs as a Kubernetes CronJob in the
// `synthetics` namespace: fetch the check definition from the platform API with the
// per-check run token, drive headless Chromium through the declared steps (no
// arbitrary scripts), and report the result (+ a PNG screenshot on failure).
//
// Network safety: the pod's egress NetworkPolicy only allows the public internet and
// the platform API. Requests to cluster-internal names, literal private addresses and
// non-HTTP(S) schemes are additionally aborted here (defence in depth).
import net from 'node:net';

const API = (process.env.PLATFORM_API_URL || 'http://platform-api.platform.svc:3000').replace(/\/+$/, '');
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

async function runStep(page, step, secrets, timeout) {
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
      if (!title.includes(step.value)) throw new Error(`title "${title.slice(0, 100)}" does not contain "${step.value}"`);
      return;
    }
    case 'assert_url': {
      if (!page.url().includes(step.value)) throw new Error(`URL does not contain "${step.value}"`);
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
  const startedAt = new Date();
  const deadline = Date.now() + (Number(def.timeoutMs) || 60_000);
  const steps = [];
  let status = 'pass';
  let error = null;
  let screenshot = null;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
    const ua = await (await context.newPage()).evaluate(() => navigator.userAgent).catch(() => '');
    await context.close();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block', userAgent: `${ua}${USER_AGENT_SUFFIX}` });
    await ctx.route('**/*', (route) => (requestAllowed(route.request().url(), allowed) ? route.continue() : route.abort('blockedbyclient')));
    const page = await ctx.newPage();
    for (const step of def.steps || []) {
      const name = describe(step);
      if (status === 'fail') { steps.push({ name, status: 'skipped' }); continue; }
      const t0 = Date.now();
      const remaining = deadline - t0;
      try {
        if (remaining <= 0) throw new Error('check timeout');
        await runStep(page, step, secrets, Math.min(remaining, 30_000));
        steps.push({ name, status: 'pass', latencyMs: Date.now() - t0 });
      } catch (err) {
        status = 'fail';
        error = redact(`${name}: ${err?.message || err}`, secrets);
        steps.push({ name, status: 'fail', latencyMs: Date.now() - t0, error: redact(err?.message || err, secrets) });
      }
    }
    if (status === 'fail') {
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
