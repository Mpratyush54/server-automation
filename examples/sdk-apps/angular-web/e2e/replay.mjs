#!/usr/bin/env node
// Real-browser session replay check (#40) against the Angular demo app (mirrors react-web/e2e/replay.mjs).
//
//   cd examples/sdk-apps/angular-web && npm i --no-save playwright@1.59.1 && npx playwright install --with-deps chromium
//   ANGULAR_URL=https://sdk-angular.$DOMAIN \
//   PLATFORM_URL=https://$DOMAIN PLATFORM_TOKEN=<portal JWT> PROJECT_ID=<project uuid> \
//   BROWSER=chromium node examples/sdk-apps/angular-web/e2e/replay.mjs        # or firefox / webkit
//
// 1. Before consent: browses and types; asserts no chunk upload and no recorder download.
// 2. Clicks "Allow session replay", fills the checkout form with personal data, navigates,
//    throws a JS error (caught by Angular's ErrorHandler, not window.onerror), then opens
//    "Order 103" and closes the page within the 5 s flush interval: that last page only
//    reaches the server through the unload path (pagehide -> keepalive flush).
// 3. With PLATFORM_URL/PLATFORM_TOKEN/PROJECT_ID: fetches the session through the portal API,
//    downloads every chunk and asserts the typed values never appear (inputs masked), that the
//    session lists the pages in visit order (first page /checkout, last page /orders/103 present)
//    and the error, that the error is linked to the replay, and that a page snapshot exists.
// Exit code 0 = pass. Prints the session id and the portal player path.
import zlib from 'node:zlib';
import * as pw from 'playwright';

const ANGULAR_URL = (process.env.ANGULAR_URL || '').replace(/\/+$/, '');
if (!ANGULAR_URL) {
  console.error('ANGULAR_URL is required (e.g. https://sdk-angular.<DOMAIN>)');
  process.exit(2);
}
const BROWSER = process.env.BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(BROWSER)) {
  console.error('BROWSER must be chromium, firefox or webkit');
  process.exit(2);
}
const PLATFORM_URL = (process.env.PLATFORM_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.PLATFORM_TOKEN || '';
const PROJECT_ID = process.env.PROJECT_ID || '';
const SECRETS = {
  name: 'Priya Raghunathan',
  email: 'priya.raghunathan77@example.org',
  password: 'Hunter2-Tr0ub4dor!',
  card: '5500 0055 5555 5559',
  notes: 'Flat 12B Lotus Tower, ring twice',
};

let failed = 0;
const check = (cond, name, detail = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${!cond && detail ? ` (${String(detail).slice(0, 400)})` : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await pw[BROWSER].launch(BROWSER === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const uploads = [];
const statuses = [];
const scripts = [];
const consentPuts = [];
page.on('request', (r) => {
  if (r.url().includes('/api/sdk/replay/chunks')) uploads.push(r.url());
  if (r.url().includes('/api/sdk/replay/consent')) consentPuts.push(r.method());
  if (r.resourceType() === 'script') scripts.push(r.url());
});
page.on('response', (r) => {
  if (r.url().includes('/api/sdk/replay/chunks')) statuses.push(r.status());
});
page.on('pageerror', () => {}); // the demo error is intentional
const recorderLoaded = () => scripts.some((u) => /rum-replay-record/.test(u)); // namedChunks in angular.json

// ---- 1. no consent: nothing recorded
await page.goto(`${ANGULAR_URL}/`, { waitUntil: 'networkidle' });
const cfg = await page.evaluate(() => fetch('/rum-config.json').then((r) => r.json()).catch(() => null));
check(!!cfg?.replayEndpoint, 'rum-config.json has replayEndpoint', JSON.stringify(cfg));
console.log(`  info browser=${BROWSER}`);
await page.getByRole('link', { name: 'Checkout' }).click();
await page.getByTestId('name').fill('Before Consent Person');
await page.getByTestId('email').fill('before.consent@example.org');
await page.waitForTimeout(6500);
check(uploads.length === 0, 'no chunk uploaded before consent', `${uploads.length} upload(s)`);
check(!recorderLoaded(), 'rrweb recorder not downloaded before consent', scripts.join(' '));

// ---- 2. consent, then a session with personal data
await page.getByTestId('replay-allow').click();
await page.waitForTimeout(2000);
check(recorderLoaded(), 'rrweb recorder downloaded after consent');
for (const [k, v] of Object.entries(SECRETS)) await page.getByTestId(k).fill(v);
await page.getByTestId('submit').click();
await page.getByRole('link', { name: 'Orders' }).click();
await page.getByRole('link', { name: 'Order 101' }).click();
await page.getByRole('link', { name: 'Home' }).click();
await page.getByRole('button', { name: 'Throw JS error' }).click();
await page.waitForTimeout(7000);
// Short final page: closed before the 5 s interval flush, so only the unload path delivers it.
await page.getByRole('link', { name: 'Orders' }).click();
await page.getByRole('link', { name: 'Order 103' }).click();
await page.waitForTimeout(800);
const sessionId = await page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('platform.replay.session') || '{}').id || null; } catch { return null; }
});
await page.close({ runBeforeUnload: true }); // pagehide -> final keepalive chunk
await sleep(2500);
await browser.close();

check(!!sessionId, 'replay session id assigned', String(sessionId));
check(uploads.length > 0, 'chunks uploaded after consent', `${uploads.length}`);
check(statuses.length > 0 && statuses.every((s) => s === 202 || s === 200), 'chunk uploads accepted (202/200)', statuses.join(','));
check(consentPuts.length > 0, 'consent PUT sent', consentPuts.join(','));
console.log(`  info session ${sessionId} uploads=${uploads.length}`);

// ---- 3. server side: masked, listed, ordered, linked, playable
if (PLATFORM_URL && TOKEN && PROJECT_ID && sessionId) {
  const api = async (path, raw = false) => {
    const res = await fetch(`${PLATFORM_URL}/api/projects/${PROJECT_ID}/replays${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
  };
  await sleep(3000);
  const list = await api('?limit=50');
  check(list.status === 200 && list.body.sessions?.some((s) => s.session_id === sessionId), 'session listed in the portal API', list.status);
  const detail = await api(`/${sessionId}`);
  check(detail.status === 200, 'session detail readable (audited as replay.view)');
  if (detail.status === 200) {
    const s = detail.body.session;
    console.log(`  info pages=${JSON.stringify(s.pages)} first_page=${s.first_page} errors=${s.error_count} chunks=${detail.body.chunks.length} linkedErrors=${(detail.body.errors || []).length}`);
    check(s.pages.includes('/checkout') && s.pages.some((p) => p.startsWith('/orders')), 'pages aggregated', JSON.stringify(s.pages));
    check(s.first_page === '/checkout', 'first page is where recording started', s.first_page);
    check(s.pages.includes('/orders/103'), 'final short page delivered on unload (keepalive)', JSON.stringify(s.pages));
    check(s.pages.indexOf('/checkout') < s.pages.indexOf('/orders/101'), 'pages in visit order', JSON.stringify(s.pages));
    check(s.error_count >= 1, 'error counted', String(s.error_count));
    // Needs RUM error ingest (Faro endpoint reachable from the demo origin).
    check((detail.body.errors || []).length >= 1, 'RUM error linked to the replay (replayId)', 'no linked errors: check Faro/CORS');
    let all = '';
    for (const c of detail.body.chunks) {
      const ch = await api(`/${sessionId}/chunks/${c.seq}`, true);
      check(ch.status === 200, `chunk ${c.seq} downloadable`);
      all += ch.buf[0] === 0x1f && ch.buf[1] === 0x8b ? zlib.gunzipSync(ch.buf).toString('utf8') : ch.buf.toString('utf8');
    }
    check(all.includes('"type":2'), 'recording contains a full DOM snapshot (playable)');
    for (const [k, v] of Object.entries(SECRETS)) check(!all.includes(v), `typed ${k} never stored`);
    check(!all.includes('Before Consent Person') && !all.includes('before.consent@'), 'pre-consent typing not stored');
    check(!all.includes('1234.56'), 'platform-mask text masked');
    check(all.includes('"tag":"error"'), 'error marker recorded');
    const snap = await api(`/latest/snapshot?page=/checkout`);
    check(snap.status === 200 && typeof snap.body.html === 'string', 'page snapshot endpoint returns HTML', snap.status);
    if (snap.status === 200) check(!Object.values(SECRETS).some((v) => snap.body.html.includes(v)), 'snapshot HTML has no typed values');
  }
  console.log(`  info player: ${PLATFORM_URL}/projects/${PROJECT_ID}/replays/${sessionId}`);
} else {
  console.log('  info set PLATFORM_URL, PLATFORM_TOKEN and PROJECT_ID to verify the stored session');
}
process.exit(failed ? 1 : 0);
