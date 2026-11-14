import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import { prepareDocsHtml } from '../src/app/pages/docs/docs-html.mjs';
import { sanitizeDocsHtml } from '../src/app/pages/docs/docs-sanitize.mjs';
import { applyHead, escapeHtml as escape, origin, PUBLIC_PAGES } from './prerender-head.mjs';

const portal = fileURLToPath(new URL('../', import.meta.url));

async function markdownFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await markdownFiles(join(directory, entry.name), `${path}/`));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

const plain = text => text
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[*_`]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function docHeading(markdown) {
  return plain(markdown.match(/^#\s+(.+)$/m)?.[1] ?? '') || 'Documentation';
}

/** A meta description from the page's opening prose: its first plain paragraphs, cut at a word near 160 characters. */
export function docDescription(markdown, limit = 160) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/```[\s\S]*?```/g, '\n\n');
  let text = '';
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed || /^(#|[-*+] |\d+\. |>|\||<|---|===)/.test(trimmed)) {
      if (text && trimmed.startsWith('#')) break;
      continue;
    }
    let paragraph = plain(trimmed);
    // A sentence ending in ":" introduces a code block or list; keep the
    // sentences before it, and skip short ones ("Describe shows:") entirely.
    if (paragraph.endsWith(':')) {
      const sentenceEnd = paragraph.lastIndexOf('. ');
      if (sentenceEnd > 0) paragraph = paragraph.slice(0, sentenceEnd + 1);
      else if (paragraph.length < 60) continue;
      else paragraph = `${paragraph.slice(0, -1)}.`;
    }
    text = `${text} ${paragraph}`.trim();
    if (text.length >= 80) break;
  }
  const heading = docHeading(markdown);
  if (text && text.length < 60 && heading !== 'Documentation') text = `${heading}. ${text}`;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit / 2)).replace(/[\s,;:.—-]+$/, '')}…`;
}

const pathFor = file => file === 'index.md' ? '/docs' : `/docs/${file.slice(0, -3)}`;

export async function prerenderDocs({ docsDir = join(portal, 'public/docs'), outputDir = join(portal, 'dist/portal/browser'), sitemapOnly = false } = {}) {
  const files = await markdownFiles(docsDir);
  const pages = files.map(file => origin + pathFor(file));
  if (!sitemapOnly) {
    const shell = await readFile(join(outputDir, 'index.html'), 'utf8');
    const { window } = new JSDOM('');
    const docs = [];
    for (const file of files) {
      const markdown = await readFile(join(docsDir, file), 'utf8');
      docs.push({ file, path: pathFor(file), markdown, heading: docHeading(markdown) });
    }
    const byPath = new Map(docs.map(doc => [doc.path, doc]));
    const headingCount = new Map();
    for (const doc of docs) headingCount.set(doc.heading, (headingCount.get(doc.heading) ?? 0) + 1);
    const seenDescriptions = new Set();
    for (const doc of docs) {
      // Titles and descriptions must be unique per page for search results.
      const section = doc.path.split('/').slice(2, -1).join(' / ');
      const name = headingCount.get(doc.heading) > 1 && section ? `${doc.heading} (${section})` : doc.heading;
      const title = `${name} | Cairn Docs`;
      let description = docDescription(doc.markdown) || `${name}, in the Cairn documentation.`;
      if (seenDescriptions.has(description)) description = `${name}: ${description}`;
      seenDescriptions.add(description);

      // Cairn > Documentation > each parent page that exists > this page.
      const trail = [{ name: 'Cairn', path: '/' }, { name: 'Documentation', path: '/docs' }];
      const segments = doc.path.split('/').slice(2);
      for (let index = 1; index < segments.length; index++) {
        const parent = byPath.get(`/docs/${segments.slice(0, index).join('/')}`);
        if (parent) trail.push({ name: parent.heading, path: parent.path });
      }
      if (doc.path !== '/docs') trail.push({ name: doc.heading, path: doc.path });
      const jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: trail.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: origin + item.path })),
        },
        {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: doc.heading,
          description,
          url: origin + doc.path,
          isPartOf: { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Cairn', url: `${origin}/` },
        },
      ];

      // Same sanitizer as the SPA: this HTML is served before Angular boots.
      const article = sanitizeDocsHtml(prepareDocsHtml(await marked.parse(doc.markdown), `/docs/${doc.file}`, origin), window);
      const breadcrumbs = trail.slice(0, -1).map(item => `<a href="${escape(item.path)}">${escape(item.name)}</a>`).join(' / ');
      // This content is sent to every client. Angular replaces app-root with its
      // interactive view on startup; the document remains readable without JS.
      const content = `<style>
      .docs-static{max-width:72ch;margin:0 auto;padding:32px 16px;color:rgb(var(--fg));font-size:16px;line-height:1.65;overflow-wrap:anywhere}
      .docs-static a{color:rgb(var(--accent-text))}.docs-static h1{font-size:2rem;line-height:1.2}
      .docs-static h2{margin-top:2em;font-size:1.375rem}.docs-static h3{font-size:1.125rem}.docs-static pre{overflow:auto;padding:14px 16px;background:rgb(var(--surface));border:1px solid rgb(var(--line));border-radius:10px}
      .docs-static table{display:block;overflow:auto;border-collapse:collapse}.docs-static td,.docs-static th{padding:8px 12px;border-bottom:1px solid rgb(var(--line))}
      .docs-static img{max-width:100%}
    </style><main class="docs-static"><nav aria-label="Breadcrumb">${breadcrumbs}</nav><article>${article}</article></main>`;
      const document = applyHead(shell, { title, description, path: doc.path, type: 'article', jsonLd })
        .replace(/<app-root><\/app-root>/, () => `<app-root>${content}</app-root>`);
      const output = join(outputDir, 'prerender', doc.path, 'index.html');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, document);
    }
  }
  // List the canonical HTML pages, omitting raw Markdown duplicates and
  // fabricated modification dates. Regenerate whenever the docs change.
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...PUBLIC_PAGES.map(path => origin + path), ...pages].map(url => `  <url><loc>${escape(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(join(outputDir, 'sitemap.xml'), sitemap);
  return pages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sitemapOnly = process.argv.includes('--sitemap-only');
  const pages = await prerenderDocs(sitemapOnly ? { sitemapOnly, outputDir: join(portal, 'public') } : {});
  console.log(`Generated ${pages.length} documentation ${sitemapOnly ? 'sitemap entries' : 'HTML pages and sitemap entries'}.`);
}
