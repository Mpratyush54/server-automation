// node --test scripts/tests/public-site-links.test.mjs
//
// Every link on the public site's own pages (landing, About, Pricing, and the
// shared header and footer) must lead somewhere real. Paths are checked against the
// files in the repository, not against the live site: a server outage must
// not hide (or fake) a broken link.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderPublicPage } from '../../platform/portal/scripts/prerender-landing.mjs';
import { loadTypeScriptModule } from '../../platform/portal/scripts/prerender-template.mjs';
import { PUBLIC_PAGES } from '../../platform/portal/scripts/prerender-head.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const portal = join(repo, 'platform/portal');
const { JSDOM } = createRequire(join(portal, 'package.json'))('jsdom');
const docsTrees = [join(repo, 'docs'), join(portal, 'public/docs')];
const shell = (await readFile(join(portal, 'src/index.html'), 'utf8'))
  .replace(/<app-root>[\s\S]*<\/app-root>/, '<app-root></app-root>');

const pages = {
  '/': new JSDOM(renderPublicPage('landing', shell)).window.document,
  '/about': new JSDOM(renderPublicPage('about', shell)).window.document,
  '/pricing': new JSDOM(renderPublicPage('pricing', shell)).window.document,
};

/**
 * Public-site routes the browser renders instead of the prerender, such as
 * sign-in: each must be a marketing-only route in app.routes.ts.
 */
const routes = await readFile(join(portal, 'src/app/app.routes.ts'), 'utf8');
const clientPages = new Set([...routes.matchAll(/path: '([\w-]+)'[^\n]*marketingOnlyGuard/g)].map(m => `/${m[1]}`));

/** The Markdown file a /docs URL shows, relative to a docs tree. */
const docsFile = path => (path === '/docs' ? 'index.md' : `${path.slice('/docs/'.length)}.md`);

/** GitHub-style heading slug, as the docs viewer and prerender use. */
const slug = text => text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

function linksOf(document) {
  return [...document.querySelectorAll('app-root a[href]')].map(a => ({
    href: a.getAttribute('href'),
    text: a.textContent.replace(/\s+/g, ' ').trim(),
  }));
}

test('the public pages are the ones the prerender and sitemap know', () => {
  assert.deepEqual(Object.keys(pages), PUBLIC_PAGES);
  for (const document of Object.values(pages)) {
    assert.ok(document.querySelector('app-site-header header.sh'), 'header rendered');
    assert.ok(document.querySelector('app-site-footer footer.sf'), 'footer rendered');
  }
});

for (const [page, document] of Object.entries(pages)) {
  test(`every link on ${page} (with header and footer) has a real target`, async () => {
    const links = linksOf(document);
    assert.ok(links.length > 5, 'links were found');
    const problems = [];
    for (const { href, text } of links) {
      const where = `${page}: "${text}" -> ${href}`;
      if (/^https:\/\//.test(href)) continue;
      if (/^(http:|javascript:|\/\/)/i.test(href)) { problems.push(`${where}: not an https or site link`); continue; }
      if (href.startsWith('#')) {
        if (!document.getElementById(href.slice(1))) problems.push(`${where}: no element ${href} on this page`);
        continue;
      }
      if (!href.startsWith('/')) { problems.push(`${where}: relative link`); continue; }
      const [path, fragment] = href.split('#');
      if (path === '/docs' || path.startsWith('/docs/')) {
        const file = docsFile(path.replace(/\/$/, ''));
        for (const tree of docsTrees) {
          if (!existsSync(join(tree, file))) problems.push(`${where}: no ${join(tree === docsTrees[0] ? 'docs' : 'platform/portal/public/docs', file)}`);
        }
        if (fragment && existsSync(join(docsTrees[0], file))) {
          const headings = [...(await readFile(join(docsTrees[0], file), 'utf8')).matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1]));
          if (!headings.includes(fragment)) problems.push(`${where}: no heading #${fragment} in ${file}`);
        }
      } else if (PUBLIC_PAGES.includes(path)) {
        if (fragment && !pages[path].getElementById(fragment)) problems.push(`${where}: no element #${fragment} on ${path}`);
      } else if (clientPages.has(path)) {
        if (fragment) problems.push(`${where}: fragment on a browser-rendered page`);
      } else {
        problems.push(`${where}: not a page of the public site`);
      }
    }
    assert.deepEqual(problems, []);
  });
}

test('every landing /docs link and feature guide has a matching doc file', () => {
  const { FEATURE_CLIPS } = loadTypeScriptModule(join(portal, 'src/app/pages/landing/landing-clips.ts'));
  const docsLinks = new Set([
    ...linksOf(pages['/']).map(link => link.href.split('#')[0]).filter(href => href.startsWith('/docs')),
    ...FEATURE_CLIPS.map(clip => clip.guide.path),
  ]);
  assert.ok(docsLinks.size >= 10, 'the landing page links to the docs');
  for (const href of docsLinks) {
    for (const tree of docsTrees) assert.ok(existsSync(join(tree, docsFile(href))), `${href} has no ${docsFile(href)} in ${tree}`);
  }
  // Each feature section offers its guide.
  for (const clip of FEATURE_CLIPS) {
    const section = pages['/'].getElementById(clip.id)?.closest('.lp-feature');
    assert.ok(section, `#${clip.id} is on the page`);
    assert.equal(section.querySelector('a.lp-guide')?.getAttribute('href'), clip.guide.path);
  }
});

test('the check itself rejects a docs link without a file', () => {
  const missing = '/docs/getting-started/no-such-page';
  assert.ok(docsTrees.every(tree => !existsSync(join(tree, docsFile(missing)))));
});
