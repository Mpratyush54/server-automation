#!/usr/bin/env node
// Generates real browser clicks and scrolls on the demo apps' /features page (heatmaps), then
// optionally checks the aggregates through the API.
//
//   npm i --no-save playwright@1 && npx playwright install --with-deps chromium
//   APP_URLS="https://sdk-react.$DOMAIN,https://sdk-angular.$DOMAIN" \
//   PLATFORM_URL="https://$DOMAIN" ADMIN_JWT=... PROJECT_ID=... node heatmap-traffic.mjs
//
// APP_URLS      comma-separated app origins (default http://localhost:5173)
// VISITS        page views per app and viewport (default 5)
// PLATFORM_URL, ADMIN_JWT, PROJECT_ID  optional: verify GET /api/projects/:id/heatmaps afterwards
import { chromium } from 'playwright';

const apps = (process.env.APP_URLS || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const visits = Math.max(1, Number(process.env.VISITS) || 5);
const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
];
// Buttons clicked on every visit; the primary CTA more often so it shows as the hot spot.
const targets = ['#cta-primary', '#cta-primary', '#cta-primary', '#cta-secondary', '[data-rum-name="learn-pricing"]', '#cta-footer'];

const browser = await chromium.launch();
let clicks = 0;
let views = 0;
try {
  for (const app of apps) {
    for (const vp of viewports) {
      for (let i = 0; i < visits; i++) {
        // Fresh context per visit: new session, sampling decision and page view.
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        const ingest = [];
        page.on('response', (r) => { if (r.url().includes('/sdk/heatmap/events')) ingest.push(r.status()); });
        await page.goto(`${app}/features`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(500); // RUM + heatmap chunk load
        for (const sel of targets) {
          const el = page.locator(sel).first();
          if (!(await el.count())) continue;
          await el.scrollIntoViewIfNeeded();
          await el.click();
          clicks++;
        }
        // Scroll to a different max depth per visit (25%..100%), then leave the page.
        const frac = 0.25 + (i % 4) * 0.25;
        await page.evaluate((f) => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * f), frac);
        await page.waitForTimeout(400);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(300);
        // SPA navigation ends the /features page view; pagehide sends its scroll depth and
        // flushes queued clicks (keepalive). Wait for that request before closing the page.
        await page.locator('a[href="/orders"]').first().click().catch(() => {});
        await page.waitForTimeout(300);
        const flushed = page.waitForResponse((r) => r.url().includes('/sdk/heatmap/events'), { timeout: 8000 }).catch(() => null);
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await flushed;
        await page.close({ runBeforeUnload: true });
        await ctx.close();
        views++;
        console.log(`${app} ${vp.name} visit ${i + 1}: ingest responses ${JSON.stringify(ingest)}`);
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`done: ${views} page views, ${clicks} clicks`);

const { PLATFORM_URL, ADMIN_JWT, PROJECT_ID } = process.env;
if (PLATFORM_URL && ADMIN_JWT && PROJECT_ID) {
  await new Promise((r) => setTimeout(r, 2000));
  const get = async (path) => {
    const res = await fetch(`${PLATFORM_URL.replace(/\/+$/, '')}/api/projects/${PROJECT_ID}${path}`, { headers: { Authorization: `Bearer ${ADMIN_JWT}` } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
  const pages = await get('/heatmaps/pages?viewport=all');
  console.log('pages:', JSON.stringify(pages.pages));
  const click = await get('/heatmaps?page=/features&viewport=all&type=click');
  const scroll = await get('/heatmaps?page=/features&viewport=all&type=scroll');
  console.log(`click total ${click.total}, cells ${click.cells.length}, max ${click.maxCell}, top ${JSON.stringify(click.topTargets.slice(0, 3))}`);
  console.log(`scroll views ${scroll.views}, reach ${JSON.stringify(scroll.reach.filter((r) => r.depth % 25 === 0))}`);
  if (!(click.total > 0) || !(scroll.views > 0)) {
    console.error('FAIL: no heatmap aggregates for /features');
    process.exit(1);
  }
  console.log('OK: heatmap aggregates present');
}
