import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { prerenderDocs } from '../../platform/portal/scripts/prerender-docs.mjs';
import { prerenderPublicPages } from '../../platform/portal/scripts/prerender-landing.mjs';
import { PUBLIC_PAGES } from '../../platform/portal/scripts/prerender-head.mjs';
import { buildDocsSearch } from '../../platform/portal/scripts/build-docs-search.mjs';

// Run against a real nginx process: NGINX_BIN=/path/to/nginx node --test <this file>.
// Without nginx (local machines) the HTTP tests are skipped and the generated
// files are still checked; in CI a missing nginx fails the run.
const nginxBin = process.env.NGINX_BIN || 'nginx';
const nginxAvailable = !spawnSync(nginxBin, ['-v'], { windowsHide: true }).error;
const useNginx = nginxAvailable || Boolean(process.env.CI);
const httpTest = useNginx
  ? test
  : (name, fn) => test(name, { skip: 'nginx is not installed; set NGINX_BIN to run the HTTP checks' }, fn);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const html = (await readFile(process.env.PORTAL_BUILD_DIR
  ? join(resolve(process.env.PORTAL_BUILD_DIR), 'index.html')
  : join(repo, 'platform/portal/src/index.html'), 'utf8'))
  .replace(/<app-root>[\s\S]*<\/app-root>/, '<app-root></app-root>')
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
const rendered = new Map();
let pages;
let home;
let about;
let root;
let directory;
let nginx;
let baseUrl;

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'public-portal-routing-')));
  root = join(directory, 'html');
  await mkdir(join(directory, 'logs'));
  await mkdir(join(directory, 'temp'));
  await cp(join(repo, 'platform/portal/public'), root, { recursive: true });
  await buildDocsSearch({ docsDir: join(root, 'docs'), output: join(root, 'docs-search.json') });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'main-TEST1234.js'), '/* content-named bundle fixture */');
  pages = await prerenderDocs({ docsDir: join(root, 'docs'), outputDir: root });
  ({ home, about } = await prerenderPublicPages({ outputDir: root }));
  for (const page of pages) {
    const path = new URL(page).pathname;
    rendered.set(path, await readFile(join(root, 'prerender', path, 'index.html'), 'utf8'));
  }

  if (!useNginx) return;
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
  baseUrl = `http://127.0.0.1:${port}`;

  // Only substitute the deployment's port and filesystem root.
  const server = (await readFile(join(repo, 'platform/portal/nginx.public.conf'), 'utf8'))
    .replace('listen 80;', `listen 127.0.0.1:${port};`)
    .replace('root /usr/share/nginx/html;', `root "${root.replaceAll('\\', '/')}";`);
  await writeFile(join(directory, 'nginx.conf'), `
daemon off;
master_process off;
pid logs/nginx.pid;
error_log logs/error.log;
events {}
http {
  access_log off;
  client_body_temp_path temp/client_body;
  proxy_temp_path temp/proxy;
  fastcgi_temp_path temp/fastcgi;
  uwsgi_temp_path temp/uwsgi;
  scgi_temp_path temp/scgi;
  ${server}
}
`);
  nginx = spawn(nginxBin, ['-p', resolve(directory).replaceAll('\\', '/') + '/', '-c', 'nginx.conf'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let failure;
  let stderr = '';
  nginx.on('error', error => { failure = error; });
  nginx.stderr.on('data', data => { stderr += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (nginx.exitCode !== null) throw new Error(`nginx exited: ${stderr}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).status === 200) return;
    } catch { /* Wait for nginx to start listening. */ }
    await setTimeout(50);
  }
  throw new Error(`nginx did not start: ${stderr}`);
});

after(async () => {
  if (nginx && nginx.exitCode === null && nginx.pid) {
    const closed = once(nginx, 'close');
    nginx.kill();
    await closed;
  }
  if (directory) {
    assert.equal(dirname(directory), await realpath(tmpdir()));
    assert.ok(basename(directory).startsWith('public-portal-routing-'));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const userAgent of ['Mozilla/5.0', 'Googlebot/2.1 (+http://www.google.com/bot.html)']) {
  for (const path of ['/', '/about', '/about/', '/docs','/docs/', '/docs/getting-started', '/docs/getting-started/', '/docs/api-reference', '/docs/api-reference/platform-api', '/docs/api-reference/platform-api/', '/docs/getting-started/platformctl', '/docs/api-reference/configuration/environment-variables']) {
    httpTest(`${userAgent.split('/')[0]} can open ${path} without a session or redirect`, async () => {
      const response = await fetch(baseUrl + path, { redirect: 'manual', headers: { 'User-Agent': userAgent } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      const expected = path.startsWith('/about') ? about : rendered.get(path.replace(/\/$/, '')) || home;
      assert.equal(await response.text(), expected);
    });
  }
}

for (const path of ['/robots.txt', '/llms.txt', '/llms-full.txt', '/docs/index.md', '/docs/getting-started/platformctl.md']) {
  httpTest(`static content is preserved at ${path}`, async () => {
    const response = await fetch(baseUrl + path, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(join(repo, 'platform/portal/public', path.slice(1)), 'utf8'));
    if (path.endsWith('.md')) assert.match(response.headers.get('content-type'), /^text\/markdown/);
    if (path.endsWith('.md')) {
      const canonical = path === '/docs/index.md' ? '/docs' : path.slice(0, -3);
      assert.equal(response.headers.get('link'), `<https://cairnpaas.dev${canonical}>; rel="canonical"`);
    }
  });
}

for (const path of ['/docs/missing.md', '/assets/missing.js', '/media/missing.mp4', '/prerender/docs/index.html']) {
  httpTest(`missing static content returns 404 at ${path}`, async () => {
    const response = await fetch(baseUrl + path, { redirect: 'manual' });
    assert.equal(response.status, 404);
  });
}

httpTest('public video, poster, and captions have browser-compatible media types', async () => {
  for (const [file, mime] of [
    ['platform-overview.mp4', 'video/mp4'], ['platform-short.mp4', 'video/mp4'],
    ['platform-overview-poster.jpg', 'image/jpeg'],
    ['platform-short-poster.jpg', 'image/jpeg'],
    ['platform-overview.en.vtt', 'text/vtt'], ['platform-short.en.vtt', 'text/vtt'],
  ]) {
    const response = await fetch(`${baseUrl}/media/${file}`);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), mime, file);
    assert.match(response.headers.get('cache-control'), /public, max-age=3600/);
    assert.match(response.headers.get('cloudflare-cdn-cache-control'), /max-age=604800/);
    const bytes = await response.arrayBuffer();
    assert.ok(bytes.byteLength > 0, file);
    if (file.endsWith('.vtt')) assert.match(new TextDecoder().decode(bytes), /^WEBVTT/);
  }
});

httpTest('content-named bundles are immutable while HTML stays out of browser and CDN caches', async () => {
  const bundle = await fetch(`${baseUrl}/main-TEST1234.js`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('cache-control'), /max-age=31536000, immutable/);
  const page = await fetch(baseUrl);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('cloudflare-cdn-cache-control'), 'no-store');
});

httpTest('legacy landing URLs redirect to the canonical homepage and preserve queries', async () => {
  for (const path of ['/landing', '/landing/', '/landing?campaign=launch']) {
    const response = await fetch(baseUrl + path, {redirect:'manual'});
    assert.equal(response.status, 308);
    const location = new URL(response.headers.get('location'), baseUrl);
    assert.equal(location.pathname, '/');
    assert.equal(location.search, new URL(baseUrl + path).search);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  }
});

httpTest('pages that moved out of the docs root redirect permanently to their new address', async () => {
  for (const [old, now] of [
    ['/docs/host-hardening', '/docs/guides/host-hardening'],
    ['/docs/host-hardening/', '/docs/guides/host-hardening'],
    ['/docs/namespace-isolation', '/docs/guides/namespace-isolation'],
    ['/docs/gitops-branches?x=1', '/docs/guides/gitops-branches?x=1'],
    ['/docs/observability-releases', '/docs/observability/releases'],
    ['/docs/host-hardening.md', '/docs/guides/host-hardening.md'],
  ]) {
    const response = await fetch(baseUrl + old, { redirect: 'manual' });
    assert.equal(response.status, 301, old);
    const location = new URL(response.headers.get('location'), baseUrl);
    assert.equal(location.pathname + location.search, now, old);
    assert.ok(response.headers.get('content-security-policy'), `${old}: security headers`);
    assert.ok(rendered.has(now.split('?')[0].replace(/\.md$/, '')), `${now} has no generated page`);
  }
});

httpTest('both videos support byte-range seeking without authentication', async () => {
  for (const file of ['platform-overview.mp4', 'platform-short.mp4']) {
    const response = await fetch(`${baseUrl}/media/${file}`, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(response.status, 206, file);
    assert.match(response.headers.get('content-range'), /^bytes 0-1023\/\d+$/);
    const source = await readFile(join(repo, 'platform/portal/public/media', file));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source.subarray(0, 1024));
  }
});

httpTest('every generated sitemap URL serves readable HTML with its own canonical', async () => {
  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.length, pages.length + PUBLIC_PAGES.length);
  assert.ok(!sitemap.includes('.md</loc>'));
  for (const url of urls) {
    const response = await fetch(baseUrl + new URL(url).pathname, { redirect: 'manual' });
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), /^text\/html/, url);
    const document = await response.text();
    const canonicals = [...document.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(match => match[1]);
    assert.deepEqual(canonicals, [url], url);
    assert.equal([...document.matchAll(/<h1[\s>]/g)].length, 1, url);
    if (pages.includes(url)) assert.match(document, /<article>[\s\S]*<h1[\s>]/, url);
    for (const script of html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)) {
      assert.ok(document.includes(script[0]), `Angular script missing at ${url}`);
    }
  }
});

test('prerendered section links stay on their docs page and have real targets', () => {
  // The HA guide links to its own sections; links must keep the page path.
  const path = '/docs/operations/ha';
  const ha = rendered.get(path);
  assert.ok(ha.includes(`href="${path}#use-an-external-load-balancer"`));
  let ownSectionLinks = 0;
  for (const [url, document] of rendered) {
    assert.ok(!/href="#/.test(document), `Bare fragment at ${url}`);
    for (const link of document.matchAll(new RegExp(`href="${url}#([^"]+)"`, 'g'))) {
      ownSectionLinks++;
      assert.ok(document.includes(`id="${link[1]}"`), `Missing section target at ${url}#${link[1]}`);
    }
  }
  assert.ok(ownSectionLinks > 0);
});

httpTest('public full-text search includes every docs page and points to real section IDs', async () => {
  const response = await fetch(`${baseUrl}/docs-search.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  const index = await response.json();
  assert.equal(index.documents, pages.length);
  assert.equal(new Set(index.entries.map(entry => entry.url.split('#')[0])).size, pages.length);
  assert.ok(index.entries.some(entry => entry.text.includes('SECRETS_ENCRYPTION_KEY')));
  assert.ok(index.entries.some(entry => entry.text.includes('WRONGPASS')));
  for (const entry of index.entries) {
    const [path, id] = entry.url.split('#');
    assert.ok(rendered.has(path), `Unrendered search result: ${entry.url}`);
    if (id) assert.ok(rendered.get(path).includes(`id="${id}"`), `Missing search target: ${entry.url}`);
  }
});

// The checks below read the generated files, so they run without nginx too.
const head = document => ({
  title: document.match(/<title>([^<]*)<\/title>/)?.[1],
  description: document.match(/<meta name="description" content="([^"]*)">/)?.[1],
  canonical: [...document.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(match => match[1]),
  ogTitle: document.match(/<meta property="og:title" content="([^"]*)">/)?.[1],
  ogDescription: document.match(/<meta property="og:description" content="([^"]*)">/)?.[1],
  ogUrl: document.match(/<meta property="og:url" content="([^"]*)">/)?.[1],
  twitterTitle: document.match(/<meta name="twitter:title" content="([^"]*)">/)?.[1],
  jsonLd: [...document.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1])),
});
const angularSyntax = /\{\{|\}\}|@(if|else|for|switch|case|default|defer|let)\b|\s\(\w[\w.-]*\)=|\s\[[\w.-]+\]=|\s\*ng\w+=|routerLink|\s#\w+=|_ngcontent/;
const bodyOf = document => document.slice(document.indexOf('<body>'));

test('the homepage explains the product and links to real docs without JavaScript', () => {
  const document = home;
  assert.equal([...document.matchAll(/<h1[\s>]/g)].length, 1);
  assert.match(document, /<h1[^>]*>\s*<span>Run your apps on your own servers\.<\/span>/);
  assert.match(document, /Installs and connects the open-source tools/);
  assert.match(document, /From one server to many\./);
  assert.doesNotMatch(bodyOf(document), angularSyntax);
  // The hero story at its first step, playing, with nothing copied yet.
  assert.match(document, /<figcaption[^>]*>Three servers share the work\. Your app is served from all of them\.<\/figcaption>/);
  assert.equal([...document.matchAll(/<li class="lp-log-[a-z]*"><time>/g)].length, 1);
  assert.match(document, /<li class="lp-log-ok"><time>18:05:40<\/time><span>all 3 servers healthy<\/span><\/li>/);
  assert.equal([...document.matchAll(/<button class="on" type="button" aria-label="Show step 1 of 5" aria-pressed="true">/g)].length, 1);
  assert.equal([...document.matchAll(/aria-pressed="false"/g)].length, 4);
  assert.match(document, /aria-label="Pause the failover story">\s*Pause\s*</);
  assert.match(document, /aria-label="Copy install commands">\s*Copy\s*</);
  assert.equal([...document.matchAll(/<g class="lp-node" transform="translate\(12 \d+\)">/g)].length, 3);
  assert.equal([...document.matchAll(/class="lp-packet"/g)].length, 3);
  assert.doesNotMatch(bodyOf(document), /class="[^"]*(lp-node-down|lp-link-down)/);
  assert.match(document, /<p class="video-error" role="alert" hidden><\/p>/);
  // Shared header and footer are rendered too.
  assert.match(document, /<app-site-header current="home">\s*<header class="sh">/);
  assert.match(document, /<a class="on" href="\/#product">Product<\/a>/);
  assert.match(document, /<footer class="sf">/);
  assert.ok(!document.includes('three.min.js'));
  assert.match(document, /platform-short\.mp4\?v=[a-f0-9]{12}/);
  for (const link of document.matchAll(/href="(\/docs[^"]*)"/g)) {
    const url = link[1].split('#')[0];
    assert.ok(rendered.has(url), `Landing-page docs link has no generated page: ${url}`);
  }
  assert.match(document, /href="\/about"/);
  assert.match(document, /<video controls [^>]*preload="none"/);
  assert.ok(!document.includes('autoplay'));
  assert.match(document, /kind="captions"/);
  assert.match(document, /<noscript><style>\.lp-play \{ display: none !important; \}<\/style><\/noscript>/);
  const { jsonLd } = head(document);
  assert.equal(jsonLd.length, 1);
  assert.ok(jsonLd[0]['@graph'].some(item => item['@type'] === 'SoftwareApplication'));
});

test('the About page is prerendered with its own content and metadata', async () => {
  assert.equal(await readFile(join(root, 'prerender', 'about', 'index.html'), 'utf8'), about);
  assert.equal([...about.matchAll(/<h1[\s>]/g)].length, 1);
  assert.match(about, /<h1 class="ab-display"><span>A platform for teams<\/span>/);
  assert.match(about, /What we hold ourselves to/);
  assert.match(about, /<a class="on" href="\/about">About<\/a>/);
  assert.match(about, /href="\/docs\/contribution-guide"/);
  assert.ok(rendered.has('/docs/contribution-guide'));
  assert.doesNotMatch(bodyOf(about), angularSyntax);
  const meta = head(about);
  assert.equal(meta.title, 'About Cairn');
  assert.deepEqual(meta.canonical, ['https://cairnpaas.dev/about']);
  assert.equal(meta.ogUrl, 'https://cairnpaas.dev/about');
  assert.equal(meta.jsonLd.length, 0);
});

test('every public page has its own title, description, canonical and social tags', () => {
  const documents = new Map([['/', home], ['/about', about], ...rendered]);
  const titles = new Map();
  const descriptions = new Map();
  for (const [path, document] of documents) {
    const meta = head(document);
    const url = `https://cairnpaas.dev${path}`;
    assert.deepEqual(meta.canonical, [url], path);
    assert.equal(meta.ogUrl, url, path);
    assert.ok(meta.title && meta.description, path);
    const text = meta.description.replace(/&(amp|quot|lt|gt);/g, '_');
    assert.ok(text.length <= 160, `${path}: description is ${text.length} characters`);
    assert.equal(meta.ogTitle, meta.title, path);
    assert.equal(meta.twitterTitle, meta.title, path);
    assert.equal(meta.ogDescription, meta.description, path);
    assert.ok(!titles.has(meta.title), `${path} repeats the title of ${titles.get(meta.title)}`);
    assert.ok(!descriptions.has(meta.description), `${path} repeats the description of ${descriptions.get(meta.description)}`);
    titles.set(meta.title, path);
    descriptions.set(meta.description, path);
    assert.equal([...document.matchAll(/<meta name="description"/g)].length, 1, path);
    if (path.startsWith('/docs')) {
      assert.match(document, /<meta property="og:type" content="article">/, path);
      const breadcrumbs = meta.jsonLd.find(item => item['@type'] === 'BreadcrumbList');
      assert.ok(breadcrumbs, `${path} has no BreadcrumbList`);
      assert.equal(breadcrumbs.itemListElement.at(-1).item, url, path);
      assert.ok(!meta.jsonLd.some(item => item['@graph']), `${path} repeats the landing-page structured data`);
    }
  }
});

test('robots.txt and the sitemap list the About and Pricing pages', async () => {
  const robots = await readFile(join(root, 'robots.txt'), 'utf8');
  assert.match(robots, /^Allow: \/about$/m);
  assert.match(robots, /^Allow: \/pricing$/m);
  assert.match(robots, /^Sitemap: https:\/\/cairnpaas.dev\/sitemap\.xml$/m);
  for (const sitemap of [await readFile(join(root, 'sitemap.xml'), 'utf8'), await readFile(join(repo, 'platform/portal/public/sitemap.xml'), 'utf8')]) {
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    assert.deepEqual(urls.slice(0, 3), ['https://cairnpaas.dev/', 'https://cairnpaas.dev/about', 'https://cairnpaas.dev/pricing']);
    assert.deepEqual(urls.slice(3), pages, 'Regenerate public/sitemap.xml: node platform/portal/scripts/prerender-docs.mjs --sitemap-only');
  }
});
