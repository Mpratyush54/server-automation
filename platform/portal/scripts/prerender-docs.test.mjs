// node --test scripts/prerender-docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prerenderDocs } from './prerender-docs.mjs';

test('prerendered docs are sanitized like the SPA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prerender-docs-'));
  try {
    const docsDir = join(root, 'docs');
    const outputDir = join(root, 'out');
    await mkdir(docsDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'index.html'), '<html><head><title>x</title></head><body><app-root></app-root></body></html>');
    await writeFile(
      join(docsDir, 'xss.md'),
      '# XSS\n\n<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n```mermaid\ngraph TD\nA</div><script>alert(3)</script>\n```\n',
    );
    await prerenderDocs({ docsDir, outputDir });
    const html = await readFile(join(outputDir, 'prerender', 'docs', 'xss', 'index.html'), 'utf8');
    const article = html.slice(html.indexOf('<article>'), html.indexOf('</article>'));
    assert.ok(article.includes('<img src="x">'), article);
    assert.doesNotMatch(article, /onerror|<script/i);
    assert.match(article, /<div class="mermaid">graph TD\nA&lt;\/div&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;<\/div>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prerendered docs get their own title, description, canonical, social tags and breadcrumbs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prerender-docs-'));
  try {
    const docsDir = join(root, 'docs');
    const outputDir = join(root, 'out');
    await mkdir(join(docsDir, 'guides'), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'index.html'), '<html><head><title>x</title><meta name="description" content="default"><link rel="canonical" href="https://cairnpaas.dev/"></head><body><app-root></app-root></body></html>');
    await writeFile(join(docsDir, 'index.md'), '# Docs home\n\nStart here.\n');
    await writeFile(join(docsDir, 'guides.md'), '# Guides\n\nTask guides.\n');
    await writeFile(join(docsDir, 'guides', 'backups.md'), '# Back up "data"\n\nRun:\n\n```bash\nplatformctl backup\n```\n\nThis page helps you back up every database in a project and restore it later, on one server or many, without stopping your app.\n');
    const pages = await prerenderDocs({ docsDir, outputDir });
    assert.deepEqual(pages.map(url => new URL(url).pathname), ['/docs/guides', '/docs/guides/backups', '/docs']);
    const html = await readFile(join(outputDir, 'prerender', 'docs', 'guides', 'backups', 'index.html'), 'utf8');
    assert.match(html, /<title>Back up &quot;data&quot; \| Cairn Docs<\/title>/);
    assert.match(html, /<meta name="description" content="This page helps you back up every database in a project and restore it later, on one server or many, without stopping your app\.">/);
    assert.equal([...html.matchAll(/<meta name="description"/g)].length, 1);
    assert.match(html, /<link rel="canonical" href="https:\/\/cairnpaas.dev\/docs\/guides\/backups">/);
    assert.match(html, /<meta property="og:type" content="article">/);
    assert.match(html, /<meta name="twitter:title" content="Back up &quot;data&quot; \| Cairn Docs">/);
    const jsonLd = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
    const breadcrumbs = jsonLd.find(item => item['@type'] === 'BreadcrumbList');
    assert.deepEqual(breadcrumbs.itemListElement.map(item => item.name), ['Cairn', 'Documentation', 'Guides', 'Back up "data"']);
    assert.match(html, /<nav aria-label="Breadcrumb"><a href="\/">Cairn<\/a> \/ <a href="\/docs">Documentation<\/a> \/ <a href="\/docs\/guides">Guides<\/a><\/nav>/);
    const sitemap = await readFile(join(outputDir, 'sitemap.xml'), 'utf8');
    assert.match(sitemap, /<loc>https:\/\/cairnpaas.dev\/about<\/loc>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
