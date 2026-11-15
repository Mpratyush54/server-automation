import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const docsRoot = path.join(publicDir, 'docs');
const base = 'https://platform.pratyushes.dev';

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

/** HTML page for a Markdown file: every docs file is prerendered at its path. */
function spaUrlFromMd(mdRelPosix) {
  const rel = mdRelPosix.replace(/^docs\//, '').replace(/\.md$/, '');
  return rel === 'index' ? `${base}/docs` : `${base}/docs/${rel}`;
}

const mdFiles = walk(docsRoot).map((f) =>
  toPosix(path.relative(publicDir, f))
);

// sitemap.xml is written by prerender-docs.mjs and robots.txt is a static
// file; this script only writes the two agent indexes.
const llms = `# Cairn

> Self-hosted Kubernetes PaaS control plane: deploy, secrets, databases, observability, SDKs, and MCP for AI agents.

Site: ${base}
Docs (HTML): ${base}/docs
Docs (Markdown corpus): ${base}/docs/
Full agent index: ${base}/llms-full.txt
Sitemap: ${base}/sitemap.xml
Source: https://github.com/Mpratyush54/server-automation

## Start here

- [Home](${base}/): product overview
- [Docs home](${base}/docs): documentation index ([Markdown](${base}/docs/index.md))
- [Installation](${base}/docs/getting-started/installation): install Cairn ([Markdown](${base}/docs/getting-started/installation.md))
- [Recover](${base}/docs/operations/recover): fix a broken install ([Markdown](${base}/docs/operations/recover.md))
- [platformctl CLI](${base}/docs/getting-started/platformctl): CLI reference ([Markdown](${base}/docs/getting-started/platformctl.md))

## For AI agents (MCP)

1. [MCP for AI agents](${base}/docs/mcp/for-agents) — hard protocol ([Markdown](${base}/docs/mcp/for-agents.md))
2. [MCP overview](${base}/docs/mcp/overview) ([Markdown](${base}/docs/mcp/overview.md))
3. [MCP setup](${base}/docs/mcp/setup) ([Markdown](${base}/docs/mcp/setup.md))
4. [MCP tools & policy](${base}/docs/mcp/tools) ([Markdown](${base}/docs/mcp/tools.md))

Prefer fetching the **.md** URLs for grounding. HTML pages are prerendered and readable without JavaScript.

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
- Cache-friendly: \`/\`, \`/docs*\`, \`/docs/**/*.md\`, static logos/favicons.
- Do not treat authenticated app routes as public content.
`;

fs.writeFileSync(path.join(publicDir, 'llms.txt'), llms);

const lines = [
  `# Cairn - full documentation index for AI agents`,
  `# Prefer these Markdown URLs for retrieval. Each is followed by its HTML page.`,
  ``,
  `Home: ${base}/`,
  `Docs HTML: ${base}/docs`,
  `llms.txt: ${base}/llms.txt`,
  `sitemap.xml: ${base}/sitemap.xml`,
  ``,
];

for (const md of mdFiles.sort()) {
  const spa = spaUrlFromMd(md);
  lines.push(`- ${base}/${md}`);
  lines.push(`  html: ${spa}`);
}

fs.writeFileSync(path.join(publicDir, 'llms-full.txt'), lines.join('\n') + '\n');

console.log(`Wrote llms.txt and llms-full.txt (${mdFiles.length} documents)`);
