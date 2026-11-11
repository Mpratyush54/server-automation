#!/usr/bin/env node
// Real-browser session replay check (#40) against the React demo app.
//
//   cd examples/sdk-apps/react-web && npm i --no-save playwright@1.59.1 && npx playwright install --with-deps chromium
//   REACT_URL=https://sdk-react.$DOMAIN \
//   PLATFORM_URL=https://$DOMAIN PLATFORM_TOKEN=<portal JWT> PROJECT_ID=<project uuid> \
//   node examples/sdk-apps/react-web/e2e/replay.mjs
//
// 1. Before consent: browses and types; asserts no chunk upload and no recorder download.
// 2. Clicks "Allow session replay", fills the checkout form with personal data, navigates,
//    throws a JS error and closes the page (pagehide -> keepalive flush).
// 3. With PLATFORM_URL/PLATFORM_TOKEN/PROJECT_ID: fetches the session through the portal API,
//    downloads every chunk and asserts the typed values never appear (inputs masked), that the
//    session lists the pages and the error, and that a page snapshot is available.
// Exit code 0 = pass. Prints the session id and the portal player path.
import { chromium } from 'playwright';

const REACT_URL = (process.env.REACT_URL || '').replace(/\/+$/, '');
if (!REACT_URL) {
  console.error('REACT_URL is required (e.g. https://sdk-react.<DOMAIN>)');
  process.exit(2);
}
const PLATFORM_URL = (process.env.PLATFORM_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.PLATFORM_TOKEN || '';
const PROJECT_ID = process.env.PROJECT_ID || '';
const SECRET_VALUES = ['Jane Tester', 'jane.tester@example.com', 'S3cret-Passw0rd!', '4111 1111 1111 1111', 'deliver after 6pm'];

let failed = 0;
const check = (cond, name, detail = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${!cond && detail ? ` (${detail})` : ''}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const uploads = [];
const scripts = [];
page.on('request', (r) => {
  if (r.url().includes('/api/sdk/replay/chunks')) uploads.push(r);
  if (r.resourceType() === 'script') scripts.push(r.url());
});
const statuses = [];
page.on('response', (r) => {
  if (r.url().includes('/api/sdk/replay/chunks')) statuses.push(r.status());
});
page.on('pageerror', () => {}); // the demo error is intentional

// ---- 1. no consent: nothing recorded
await page.goto(`${REACT_URL}/`, { waitUntil: 'networkidle' });
const cfg = await page.evaluate(() => fetch('/rum-config.json').then((r) => r.json()).catch(() => null));
check(!!cfg?.replayEndpoint, 'rum-config.json has replayEndpoint', JSON.stringify(cfg));
await page.getByRole('link', { name: 'Checkout' }).click();
await page.getByTestId('name').fill('Before Consent');
await page.waitForTimeout(6500);
check(uploads.length === 0, 'no chunk uploaded before consent', `${uploads.length} upload(s)`);
const recorderBefore = scripts.filter((u) => /rum-replay-record/.test(u)).length;
check(recorderBefore === 0, 'rrweb recorder not downloaded before consent', scripts.join(' '));

// ---- 2. consent, then a session with personal data
await page.getByTestId('replay-allow').click();
await page.waitForTimeout(1500);
await page.getByTestId('name').fill(SECRET_VALUES[0]);
await page.getByTestId('email').fill(SECRET_VALUES[1]);
await page.getByTestId('password').fill(SECRET_VALUES[2]);
await page.getByTestId('card').fill(SECRET_VALUES[3]);
await page.getByTestId('notes').fill(SECRET_VALUES[4]);
await page.getByTestId('submit').click();
await page.getByRole('link', { name: 'Orders' }).click();
await page.getByRole('link', { name: 'Order 101' }).click();
await page.getByRole('link', { name: 'Home' }).click();
await page.getByRole('button', { name: 'Throw JS error' }).click();
await page.waitForTimeout(7000);
const sessionId = await page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('platform.replay.session') || '{}').id || null; } catch { return null; }
});
await page.close({ runBeforeUnload: true }); // pagehide -> final keepalive chunk
await new Promise((r) => setTimeout(r, 2000));
await browser.close();

check(!!sessionId, 'replay session id assigned', String(sessionId));
check(uploads.length > 0, 'chunks uploaded after consent', `${uploads.length}`);
check(statuses.length > 0 && statuses.every((s) => s === 202 || s === 200), 'chunk uploads accepted (202/200)', statuses.join(','));
check(scripts.some((u) => /rum-replay-record/.test(u)), 'rrweb recorder downloaded after consent');
console.log(`  info session ${sessionId}`);

// ---- 3. server side: masked, listed, playable
if (PLATFORM_URL && TOKEN && PROJECT_ID && sessionId) {
  const api = async (path) => {
    const res = await fetch(`${PLATFORM_URL}/api/projects/${PROJECT_ID}/replays${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
  };
  await new Promise((r) => setTimeout(r, 3000));
  const list = await api('?limit=20');
  check(list.status === 200 && list.body.sessions.some((s) => s.session_id === sessionId), 'session listed in the portal API');
  const detail = await api(`/${sessionId}`);
  check(detail.status === 200, 'session detail readable (audited as replay.view)');
  if (detail.status === 200) {
    const s = detail.body.session;
    check(s.pages.includes('/checkout') && s.pages.some((p) => p.startsWith('/orders')), 'pages aggregated', JSON.stringify(s.pages));
    check(s.error_count >= 1, 'error counted', String(s.error_count));
    let all = '';
    for (const c of detail.body.chunks) {
      const chunk = await api(`/${sessionId}/chunks/${c.seq}`);
      check(chunk.status === 200, `chunk ${c.seq} downloadable`);
      all += JSON.stringify(chunk.body);
    }
    check(all.includes('"type":2'), 'recording contains a full DOM snapshot (playable)');
    for (const v of SECRET_VALUES) check(!all.includes(v), `typed value never stored: ${v.slice(0, 4)}…`);
    check(!all.includes('1234.56'), 'platform-mask text masked');
    check(all.includes('"tag":"error"'), 'error marker recorded');
    const snap = await api(`/latest/snapshot?page=/checkout`);
    check(snap.status === 200 && typeof snap.body.html === 'string', 'page snapshot endpoint returns HTML');
  }
  console.log(`  info player: ${PLATFORM_URL}/projects/${PROJECT_ID}/replays/${sessionId}`);
} else {
  console.log('  info set PLATFORM_URL, PLATFORM_TOKEN and PROJECT_ID to verify the stored session');
}
process.exit(failed ? 1 : 0);
