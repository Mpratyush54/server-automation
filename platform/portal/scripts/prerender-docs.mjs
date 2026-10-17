import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { prepareDocsHtml } from '../src/app/pages/docs/docs-html.mjs';

const portal = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://platform.pratyushes.dev';
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function markdownFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await markdownFiles(join(directory, entry.name), `${path}/`));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

export async function prerenderDocs({ docsDir = join(portal, 'public/docs'), outputDir = join(portal, 'dist/portal/browser'), sitemapOnly = false } = {}) {
  const files = await markdownFiles(docsDir);
  const shell = sitemapOnly ? '' : await readFile(join(outputDir, 'index.html'), 'utf8');
  const pages = [];
  for (const file of files) {
    const path = file === 'index.md' ? '/docs' : `/docs/${file.slice(0, -3)}`;
    const canonical = origin + path;
    pages.push(canonical);
    if (sitemapOnly) continue;
    const markdown = await readFile(join(docsDir, file), 'utf8');
    const heading = markdown.match(/^#\s+(.+)$/m)?.[1].replace(/[*`]/g, '').trim() || 'Documentation';
    const title = `${heading} | Platform Docs`;
    const description = `Read ${heading} in the Platform documentation. Guides and reference for the self-hosted Platform control plane.`;
    const article = prepareDocsHtml(await marked.parse(markdown), `/docs/${file}`, origin);
    // This content is sent to every client. Angular replaces app-root with its
    // interactive view on startup; the document remains readable without JS.
    const content = `<style>
      .docs-static{max-width:1000px;margin:0 auto;padding:32px 24px;color:#e4e4e7;font:16px/1.7 system-ui;overflow-wrap:anywhere}
      .docs-static a{color:#60a5fa}.docs-static h1{font-size:2.25rem;line-height:1.2}
      .docs-static h2{margin-top:2em;font-size:1.5rem}.docs-static h3{font-size:1.2rem}.docs-static pre{overflow:auto;padding:16px;background:#18181b;border-radius:8px}
      .docs-static table{display:block;overflow:auto;border-collapse:collapse}.docs-static td,.docs-static th{padding:8px;border:1px solid #3f3f46}
      .docs-static img{max-width:100%}
    </style><main class="docs-static"><nav><a href="/">Platform</a> / <a href="/docs">Documentation</a></nav><article>${article}</article></main>`;
    let document = shell.replace(/<title>[^<]*<\/title>/, () => `<title>${escape(title)}</title>`)
      .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escape(canonical)}">`)
      .replace(/<app-root><\/app-root>/, () => `<app-root>${content}</app-root>`);
    for (const [key, value] of [['description', description], ['og:title', title], ['og:description', description], ['og:url', canonical], ['twitter:title', title], ['twitter:description', description]]) {
      const attribute = key.startsWith('og:') ? 'property' : 'name';
      document = document.replace(new RegExp(`<meta ${attribute}="${key}"[^>]*>`), () => `<meta ${attribute}="${key}" content="${escape(value)}">`);
    }
    const output = join(outputDir, 'prerender', path, 'index.html');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, document);
  }
  // List the canonical HTML pages, omitting raw Markdown duplicates and
  // fabricated modification dates. Regenerate whenever the docs change.
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[origin + '/', ...pages].map(url => `  <url><loc>${escape(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(join(outputDir, 'sitemap.xml'), sitemap);
  return pages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sitemapOnly = process.argv.includes('--sitemap-only');
  const pages = await prerenderDocs(sitemapOnly ? { sitemapOnly, outputDir: join(portal, 'public') } : {});
  console.log(`Generated ${pages.length} documentation ${sitemapOnly ? 'sitemap entries' : 'HTML pages and sitemap entries'}.`);
}
