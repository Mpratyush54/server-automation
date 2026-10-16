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

// Run against a real nginx process: NGINX_BIN=/path/to/nginx node --test <this file>.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const html = await readFile(process.env.PORTAL_BUILD_DIR
  ? join(resolve(process.env.PORTAL_BUILD_DIR), 'index.html')
  : join(repo, 'platform/portal/src/index.html'), 'utf8');
const rendered = new Map();
let pages;
let directory;
let nginx;
let baseUrl;

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'public-portal-routing-')));
  const root = join(directory, 'html');
  await mkdir(join(directory, 'logs'));
  await mkdir(join(directory, 'temp'));
  await cp(join(repo, 'platform/portal/public'), root, { recursive: true });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), html);
  pages = await prerenderDocs({ docsDir: join(root, 'docs'), outputDir: root });
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
      assert.equal(await response.text(), rendered.get(path.replace(/\/$/, '')) || html);
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

for (const path of ['/docs/missing.md', '/assets/missing.js', '/prerender/docs/index.html']) {
  test(`missing static content returns 404 at ${path}`, async () => {
    const response = await fetch(baseUrl + path, { redirect: 'manual' });
    assert.equal(response.status, 404);
  });
}

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
    assert.match(document, /<article>[\s\S]*<h1>/, url);
    for (const script of html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)) {
      assert.ok(document.includes(script[0]), `Angular script missing at ${url}`);
    }
  }
});
