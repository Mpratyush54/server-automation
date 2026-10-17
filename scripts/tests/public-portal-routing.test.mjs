import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { prerenderDocs } from '../../platform/portal/scripts/prerender-docs.mjs';
import { prerenderLanding } from '../../platform/portal/scripts/prerender-landing.mjs';
import { buildDocsSearch } from '../../platform/portal/scripts/build-docs-search.mjs';

// Run against a real nginx process: NGINX_BIN=/path/to/nginx node --test <this file>.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const html = (await readFile(process.env.PORTAL_BUILD_DIR
  ? join(resolve(process.env.PORTAL_BUILD_DIR), 'index.html')
  : join(repo, 'platform/portal/src/index.html'), 'utf8'))
  .replace(/<app-root>[\s\S]*<\/app-root>/, '<app-root></app-root>')
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
const rendered = new Map();
let pages;
let home;
let directory;
let nginx;
let baseUrl;

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'public-portal-routing-')));
  const root = join(directory, 'html');
  await mkdir(join(directory, 'logs'));
  await mkdir(join(directory, 'temp'));
  await cp(join(repo, 'platform/portal/public'), root, { recursive: true });
  await buildDocsSearch({ docsDir: join(root, 'docs'), output: join(root, 'docs-search.json') });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'main-TEST1234.js'), '/* content-named bundle fixture */');
  pages = await prerenderDocs({ docsDir: join(root, 'docs'), outputDir: root });
  home = await prerenderLanding({ outputDir: root });
  for (const page of pages) {
    const path = new URL(page).pathname;
    rendered.set(path, await readFile(join(root, 'prerender', path, 'index.html'), 'utf8'));
  }

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
  nginx = spawn(process.env.NGINX_BIN || 'nginx', ['-p', resolve(directory).replaceAll('\\', '/') + '/', '-c', 'nginx.conf'], {
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
  for (const path of ['/', '/landing', '/docs', '/docs/', '/docs/getting-started', '/docs/getting-started/', '/docs/api-reference', '/docs/api-reference/platform-api', '/docs/api-reference/platform-api/', '/docs/getting-started/platformctl', '/docs/api-reference/configuration/environment-variables']) {
    test(`${userAgent.split('/')[0]} can open ${path} without a session or redirect`, async () => {
      const response = await fetch(baseUrl + path, { redirect: 'manual', headers: { 'User-Agent': userAgent } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(await response.text(), rendered.get(path.replace(/\/$/, '')) || home);
    });
  }
}

for (const path of ['/robots.txt', '/llms.txt', '/llms-full.txt', '/docs/index.md', '/docs/getting-started/platformctl.md']) {
  test(`static content is preserved at ${path}`, async () => {
    const response = await fetch(baseUrl + path, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(join(repo, 'platform/portal/public', path.slice(1)), 'utf8'));
    if (path.endsWith('.md')) assert.match(response.headers.get('content-type'), /^text\/markdown/);
    if (path.endsWith('.md')) {
      const canonical = path === '/docs/index.md' ? '/docs' : path.slice(0, -3);
      assert.equal(response.headers.get('link'), `<https://platform.pratyushes.dev${canonical}>; rel="canonical"`);
    }
  });
}

for (const path of ['/docs/missing.md', '/assets/missing.js', '/media/missing.mp4', '/prerender/docs/index.html']) {
  test(`missing static content returns 404 at ${path}`, async () => {
    const response = await fetch(baseUrl + path, { redirect: 'manual' });
    assert.equal(response.status, 404);
  });
}

test('public video, poster, and captions have browser-compatible media types', async () => {
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

test('content-named bundles are immutable while HTML revalidates', async () => {
  const bundle = await fetch(`${baseUrl}/main-TEST1234.js`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('cache-control'), /max-age=31536000, immutable/);
  const page = await fetch(baseUrl);
  assert.equal(page.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.equal(page.headers.get('cloudflare-cdn-cache-control'), null);
});

test('both videos support byte-range seeking without authentication', async () => {
  for (const file of ['platform-overview.mp4', 'platform-short.mp4']) {
    const response = await fetch(`${baseUrl}/media/${file}`, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(response.status, 206, file);
    assert.match(response.headers.get('content-range'), /^bytes 0-1023\/\d+$/);
    const source = await readFile(join(repo, 'platform/portal/public/media', file));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source.subarray(0, 1024));
  }
});

test('every generated sitemap URL serves readable HTML with its own canonical', async () => {
  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.length, pages.length + 1);
  assert.ok(!sitemap.includes('.md</loc>'));
  for (const url of pages) {
    const response = await fetch(baseUrl + new URL(url).pathname, { redirect: 'manual' });
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), /^text\/html/, url);
    const document = await response.text();
    const canonicals = [...document.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(match => match[1]);
    assert.deepEqual(canonicals, [url], url);
    assert.match(document, /<article>[\s\S]*<h1[\s>]/, url);
    for (const script of html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)) {
      assert.ok(document.includes(script[0]), `Angular script missing at ${url}`);
    }
  }
});

test('prerendered section links stay on their docs page and have real targets', async () => {
  const path = '/docs/getting-started/installation';
  const document = await (await fetch(baseUrl + path)).text();
  for (const id of ['local-development', 'deploy-to-a-server-single-command']) {
    assert.ok(document.includes(`href="${path}#${id}"`));
    assert.ok(document.includes(`id="${id}"`));
  }
  for (const [url, document] of rendered) {
    assert.ok(!/href="#/.test(document), `Bare fragment at ${url}`);
  }
});

test('public full-text search includes every docs page and points to real section IDs', async () => {
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

test('the homepage explains the product and links to real docs without JavaScript', async () => {
  const response = await fetch(baseUrl);
  const document = await response.text();
  assert.equal(response.status, 200);
  assert.equal([...document.matchAll(/<h1[\s>]/g)].length, 1);
  assert.match(document, /Ship your apps/);
  assert.match(document, /From separate tools to one platform/);
  assert.match(document, /YOU GET/);
  assert.match(document, /self-hosted PaaS/);
  assert.match(document, /<details>\s*<summary>What is Platform\?/);
  assert.ok(!document.includes('{{'));
  assert.ok(!document.includes('routerLink='));
  assert.ok(!document.includes('three.min.js'));
  assert.match(document, /data-story-step="0"/);
  assert.match(document, /class="story-chapters"/);
  assert.ok(!document.includes('Read the video transcript'));
  assert.ok(!document.includes('Download the portrait cut'));
  assert.ok(!document.includes('Conceptual illustrations · English narration'));
  assert.match(document, /platform-short\.mp4\?v=[a-f0-9]{12}/);
  for (const link of document.matchAll(/href="(\/docs[^"]*)"/g)) {
    const url = link[1].split('#')[0];
    assert.ok(rendered.has(url), `Landing-page docs link has no generated page: ${url}`);
  }
  assert.match(document, /<video[^>]*preload="none"/);
  assert.ok(!document.includes('autoplay'));
  assert.match(document, /kind="captions"/);
  const schema = JSON.parse(document.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.ok(schema['@graph'].some(item => item['@type'] === 'SoftwareApplication'));
});
