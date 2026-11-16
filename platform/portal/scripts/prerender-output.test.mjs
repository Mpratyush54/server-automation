// node --test scripts/prerender-output.test.mjs
//
// Checks the real build output of `npm run build:public` (#189): every public
// page (/, /about and one page per docs file) exists as prerendered HTML with
// its own <title>, meta description and canonical URL, and the sitemap lists
// exactly those pages. Set PORTAL_BUILD_DIR to check another directory; when
// no build exists the test is skipped (CI builds first, then runs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { origin, PUBLIC_PAGES } from './prerender-head.mjs';

const portal = fileURLToPath(new URL('../', import.meta.url));
const build = resolve(process.env.PORTAL_BUILD_DIR ?? join(portal, 'dist/portal/browser'));
const built = existsSync(join(build, 'prerender', 'docs', 'index.html'));
const skip = built ? false : `no prerendered build in ${build}; run npm run build:public first`;

async function markdownFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await markdownFiles(join(directory, entry.name), `${path}/`));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

const unescape = value => value
  .replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function head(document) {
  const all = (pattern) => [...document.matchAll(pattern)].map(match => unescape(match[1]));
  return {
    titles: all(/<title>([^<]*)<\/title>/g),
    descriptions: all(/<meta name="description" content="([^"]*)">/g),
    canonicals: all(/<link rel="canonical" href="([^"]+)">/g),
    ogUrls: all(/<meta property="og:url" content="([^"]*)">/g),
  };
}

test('every public page in the build has its own title, description and canonical URL', { skip }, async () => {
  const docs = (await markdownFiles(join(build, 'docs'))).map(file => file === 'index.md' ? '/docs' : `/docs/${file.slice(0, -3)}`);
  assert.ok(docs.length > 50, `only ${docs.length} docs pages found in ${build}/docs`);
  const fileFor = path => path === '/' ? join(build, 'index.html') : join(build, 'prerender', path, 'index.html');

  const titles = new Map();
  const descriptions = new Map();
  for (const path of [...PUBLIC_PAGES, ...docs]) {
    assert.ok(existsSync(fileFor(path)), `${path} was not prerendered`);
    const meta = head(await readFile(fileFor(path), 'utf8'));
    const url = origin + (path === '/' ? '/' : path);
    assert.equal(meta.titles.length, 1, `${path}: expected one <title>`);
    assert.equal(meta.descriptions.length, 1, `${path}: expected one meta description`);
    assert.deepEqual(meta.canonicals, [url], `${path}: canonical`);
    assert.deepEqual(meta.ogUrls, [url], `${path}: og:url`);
    const [title] = meta.titles;
    const [description] = meta.descriptions;
    assert.ok(title.trim().length >= 5, `${path}: title is empty or too short`);
    assert.ok(description.trim().length >= 50, `${path}: description is too short (${description.length} characters): ${description}`);
    assert.ok(description.length <= 160, `${path}: description is ${description.length} characters`);
    assert.ok(!titles.has(title), `${path} repeats the title of ${titles.get(title)}: ${title}`);
    assert.ok(!descriptions.has(description), `${path} repeats the description of ${descriptions.get(description)}`);
    titles.set(title, path);
    descriptions.set(description, path);
  }
});

test('the built sitemap lists every prerendered public page once', { skip }, async () => {
  const sitemap = await readFile(join(build, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length, 'duplicate sitemap entries');
  for (const url of urls) {
    const path = new URL(url).pathname;
    const file = path === '/' ? join(build, 'index.html') : join(build, 'prerender', path, 'index.html');
    assert.ok(existsSync(file), `sitemap lists ${url}, which was not prerendered`);
  }
  const docs = await markdownFiles(join(build, 'docs'));
  assert.equal(urls.length, docs.length + PUBLIC_PAGES.length);
});
