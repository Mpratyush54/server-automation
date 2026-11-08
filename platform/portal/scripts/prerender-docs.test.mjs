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
