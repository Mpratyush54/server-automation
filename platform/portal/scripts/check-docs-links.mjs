// Check that every link between documentation pages resolves (#189).
//
//   node scripts/check-docs-links.mjs [docsDir]
//
// Links are resolved the way the docs viewer and the prerendered pages see
// them: Markdown is rendered with marked and passed through prepareDocsHtml,
// so `../guides/x.md#y` becomes `/docs/guides/x#y` and heading IDs are the
// ones the viewer generates. A link fails when its page does not exist, when
// its #fragment is not a heading or explicit id on that page, or when a
// relative link leaves docs/ (it would 404 on the public site).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { prepareDocsHtml } from '../src/app/pages/docs/docs-html.mjs';

const origin = 'https://docs.invalid';
const portal = fileURLToPath(new URL('../', import.meta.url));

async function files(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await files(join(directory, entry.name), `${path}/`));
    else found.push(path);
  }
  return found.sort();
}

const pagePath = file => file === 'index.md' ? '/docs' : `/docs/${file.slice(0, -3)}`;
const decode = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"');

/** Returns a list of { file, href, problem } for every broken link under docsDir. */
export async function checkDocsLinks(docsDir) {
  const all = await files(docsDir);
  const markdown = all.filter(file => file.endsWith('.md'));
  const pages = new Map();
  for (const file of markdown) {
    const html = prepareDocsHtml(await marked.parse(await readFile(join(docsDir, file), 'utf8')), `/docs/${file}`, origin);
    const ids = new Set([...html.matchAll(/\b(?:id|name)="([^"]+)"/g)].map(match => decode(match[1])));
    pages.set(pagePath(file), { file, html, ids });
  }
  const otherFiles = new Set(all.filter(file => !file.endsWith('.md')).map(file => `/docs/${file}`));
  const directories = new Set(all.flatMap(file => {
    const parts = file.split('/').slice(0, -1);
    return parts.map((_, index) => `/docs/${parts.slice(0, index + 1).join('/')}`);
  }));

  const problems = [];
  for (const { file, html } of pages.values()) {
    for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
      const href = decode(match[1]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(origin)) continue; // https:, mailto:, ...
      const url = new URL(href, `${origin}/docs/${file}`);
      if (url.origin !== origin) continue;
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (!path.startsWith('/docs')) {
        problems.push({ file, href, problem: 'leaves docs/ (not published on the site)' });
        continue;
      }
      const page = pages.get(path);
      if (!page) {
        if (otherFiles.has(path) || directories.has(path)) continue;
        problems.push({ file, href, problem: `no page at ${path}` });
        continue;
      }
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (fragment && !page.ids.has(fragment)) {
        problems.push({ file, href, problem: `no #${fragment} on ${path}` });
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const docsDir = resolve(process.argv[2] ?? join(portal, '../../docs'));
  await stat(docsDir);
  const problems = await checkDocsLinks(docsDir);
  for (const { file, href, problem } of problems) console.log(`${file}: ${href} — ${problem}`);
  console.log(problems.length ? `${problems.length} broken link(s).` : 'All documentation links resolve.');
  process.exitCode = problems.length ? 1 : 0;
}
