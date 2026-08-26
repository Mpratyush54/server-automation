import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const docsRoot = path.join(publicDir, 'docs');
const base = 'https://platform.pratyushes.dev';
const today = new Date().toISOString().slice(0, 10);

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** SPA HTML twin for a markdown path, or null when the SPA cannot render it. */
function spaUrlFromMd(mdRelPosix) {
  let rel = mdRelPosix.replace(/^docs\//, '').replace(/\.md$/, '');
  if (rel === 'index' || rel === '') return `${base}/docs`;
  // README indexes are not wired as /docs/:section/:page
  if (/\/README$/i.test(rel) || rel === 'README') return null;
  const parts = rel.split('/');
  // DocsComponent only loads `/docs/${section}/${page}.md` (needs ≥2 segments)
  // or `/docs/index.md`. Top-level files (faq.md, changelog.md) are Markdown-only.
  if (parts.length < 2) return null;
  const page = parts.pop();
  const section = parts.join('/');
  return `${base}/docs/${section}/${page}`;
}

const mdFiles = walk(docsRoot).map((f) =>
  toPosix(path.relative(publicDir, f))
);

const urls = [
  { loc: `${base}/`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${base}/landing`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${base}/docs`, priority: '0.9', changefreq: 'weekly' },
  { loc: `${base}/llms.txt`, priority: '0.8', changefreq: 'weekly' },
  { loc: `${base}/llms-full.txt`, priority: '0.7', changefreq: 'weekly' },
];

const seen = new Set(urls.map((u) => u.loc));

for (const md of mdFiles) {
  const spa = spaUrlFromMd(md);
  if (spa && !seen.has(spa)) {
    seen.add(spa);
    urls.push({
      loc: spa,
      priority: spa.includes('/mcp/') ? '0.85' : '0.7',
      changefreq: 'weekly',
    });
  }
  const mdLoc = `${base}/${md}`;
  if (!seen.has(mdLoc)) {
    seen.add(mdLoc);
    urls.push({
      loc: mdLoc,
      priority: md.includes('/mcp/')
        ? '0.8'
        : /^docs\/[^/]+\.md$/.test(md)
          ? '0.75'
          : '0.65',
      changefreq: 'weekly',
    });
  }
}

urls.sort((a, b) => a.loc.localeCompare(b.loc));

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`;

fs.writeFileSync(path.join(publicDir, 'sitemap.xml'), xml);

const robots = `# platform.pratyushes.dev — marketing + docs only
User-agent: *
Allow: /
Allow: /landing
Allow: /docs
Allow: /docs/
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /sitemap.xml
Allow: /logo-
Allow: /favicon
Allow: /apple-touch-icon.png

# Prefer canonical marketing/docs surfaces
Disallow: /api/
Disallow: /dashboard
Disallow: /login
Disallow: /projects
Disallow: /settings
Disallow: /oauth/

Sitemap: ${base}/sitemap.xml
`;

fs.writeFileSync(path.join(publicDir, 'robots.txt'), robots);

const llms = `# Platform

> Self-hosted Kubernetes PaaS control plane: deploy, secrets, databases, observability, SDKs, and MCP for AI agents.

Site: ${base}
Docs (HTML): ${base}/docs
Docs (Markdown corpus): ${base}/docs/
Full agent index: ${base}/llms-full.txt
Sitemap: ${base}/sitemap.xml
Source: https://github.com/Mpratyush54/SERVER-automation

## Start here

- [Landing](${base}/landing): product overview
- [Docs home](${base}/docs): documentation index ([Markdown](${base}/docs/index.md))
- [Installation](${base}/docs/getting-started/installation): install Platform ([Markdown](${base}/docs/getting-started/installation.md))
- [platformctl CLI](${base}/docs/getting-started/platformctl): CLI reference ([Markdown](${base}/docs/getting-started/platformctl.md))

## For AI agents (MCP)

1. [MCP for AI agents](${base}/docs/mcp/for-agents) — hard protocol ([Markdown](${base}/docs/mcp/for-agents.md))
2. [MCP overview](${base}/docs/mcp/overview) ([Markdown](${base}/docs/mcp/overview.md))
3. [MCP setup](${base}/docs/mcp/setup) ([Markdown](${base}/docs/mcp/setup.md))
4. [MCP tools & policy](${base}/docs/mcp/tools) ([Markdown](${base}/docs/mcp/tools.md))

Prefer fetching the **.md** URLs for grounding. HTML routes are the human SPA shell.

## Product docs

- Getting started: ${base}/docs/getting-started/installation
- Guides: ${base}/docs/guides/authentication
- Architecture: ${base}/docs/architecture/overview
- Deployment: ${base}/docs/deployment/bootstrap
- API reference: ${base}/docs/api-reference/platform-api/auth
- FAQ: ${base}/docs/faq.md
- Changelog: ${base}/docs/changelog.md
- Contributing: ${base}/docs/contribution-guide.md

## SDKs

- Node.js: ${base}/docs/getting-started/node-sdk-quickstart
- React: ${base}/docs/getting-started/react-sdk-quickstart
- Angular: ${base}/docs/getting-started/angular-sdk-quickstart
- Python: ${base}/docs/getting-started/python-sdk-quickstart

## Optional live API (when deployed on an app host)

- OpenAPI JSON: \`GET /api/openapi.json\` (not served as marketing content on this host)

## Crawl notes

- Public host serves marketing + docs only.
- Cache-friendly: \`/\`, \`/landing\`, \`/docs*\`, \`/docs/**/*.md\`, static logos/favicons.
- Do not treat authenticated app routes as public content.
`;

fs.writeFileSync(path.join(publicDir, 'llms.txt'), llms);

const lines = [
  `# Platform - full documentation index for AI agents`,
  `# Generated ${today}`,
  `# Prefer these Markdown URLs for retrieval. HTML twin listed when the SPA can render it.`,
  ``,
  `Home: ${base}/`,
  `Landing: ${base}/landing`,
  `Docs HTML: ${base}/docs`,
  `llms.txt: ${base}/llms.txt`,
  `sitemap.xml: ${base}/sitemap.xml`,
  ``,
];

for (const md of mdFiles.sort()) {
  const spa = spaUrlFromMd(md);
  lines.push(`- ${base}/${md}`);
  if (spa) lines.push(`  html: ${spa}`);
}

fs.writeFileSync(path.join(publicDir, 'llms-full.txt'), lines.join('\n') + '\n');

console.log(`Wrote robots.txt, sitemap.xml (${urls.length} URLs), llms.txt, llms-full.txt`);
