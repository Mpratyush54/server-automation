// node --test scripts/docs-links.test.mjs
// Documentation links, sidebar entries and old addresses all lead somewhere (#189).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocsLinks } from './check-docs-links.mjs';

const portal = fileURLToPath(new URL('../', import.meta.url));
const repoDocs = join(portal, '../../docs');
const nav = await readFile(join(portal, 'src/app/pages/docs/docs-nav.ts'), 'utf8');

async function markdownFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await markdownFiles(join(directory, entry.name), `${path}/`));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

/** Entries of a `const NAME: Record<string, string> = { ... }` block in docs-nav.ts. */
function record(name) {
  const body = nav.match(new RegExp(`export const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1];
  assert.ok(body, `${name} not found in docs-nav.ts`);
  return Object.fromEntries([...body.matchAll(/^\s*'?([\w-]+)'?:\s*'([^']+)'/gm)].map(match => [match[1], match[2]]));
}

const fileFor = url => url === '/docs' ? 'index.md' : `${url.slice('/docs/'.length)}.md`;

for (const [name, dir] of [['docs/', repoDocs], ['public/docs/', join(portal, 'public/docs')]]) {
  test(`every relative link and #section in ${name} resolves`, async () => {
    const problems = await checkDocsLinks(dir);
    assert.deepEqual(problems.map(({ file, href, problem }) => `${file}: ${href} — ${problem}`), []);
  });
}

test('the link checker reports missing pages, missing sections and links out of docs/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-links-'));
  try {
    await mkdir(join(root, 'guides'));
    await writeFile(join(root, 'index.md'), '# Home\n\n[ok](guides/a.md#first-step) [gone](guides/missing.md) [bad](guides/a.md#nope) [out](../README.md) [web](https://example.com/x)\n');
    await writeFile(join(root, 'guides/a.md'), '# A\n\n## First step\n\n[back](../index.md#home) [self](#first-step)\n');
    const problems = (await checkDocsLinks(root)).map(p => `${p.file}: ${p.href}`);
    assert.deepEqual(problems, ['index.md: /docs/guides/missing', 'index.md: /docs/guides/a#nope', 'index.md: ../README.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every sidebar entry has a page and every page is in the sidebar', async () => {
  const files = new Set(await markdownFiles(repoDocs));
  const listed = [...nav.matchAll(/\bp\('[^']*',\s*'([^']*)'/g)].map(match => match[1] ? `${match[1]}.md` : 'index.md');
  for (const file of listed) assert.ok(files.has(file), `sidebar links to docs/${file}, which does not exist`);
  const missing = [...files].filter(file => !listed.includes(file));
  assert.deepEqual(missing, [], 'pages missing from the sidebar in docs-nav.ts');
});

test('short addresses and moved pages lead to real pages, and nginx redirects the moved ones', async () => {
  const aliases = record('DOC_ALIASES');
  const moved = record('MOVED_DOCS');
  for (const [alias, target] of Object.entries({ ...aliases, ...moved })) {
    assert.ok(existsSync(join(repoDocs, fileFor(target))), `/docs/${alias} points at ${target}, which has no page`);
    assert.ok(!existsSync(join(repoDocs, `${alias}.md`)), `/docs/${alias} is both a page and an alias`);
  }
  const conf = await readFile(join(portal, 'nginx.public.conf'), 'utf8');
  for (const [old, target] of Object.entries(moved)) {
    const location = [...conf.matchAll(/location ~ \^\/docs\/([^\s]+) \{\s*return 301 ([^;]+);/g)]
      .find(match => new RegExp(`^${match[1]}`).test(`${old}`));
    assert.ok(location, `nginx.public.conf has no redirect for /docs/${old}`);
    const groups = new RegExp(`^${location[1]}`).exec(old).groups ?? {};
    const destination = location[2]
      .replace(/\$(\w+)/g, (_, name) => name === 'is_args' || name === 'args' ? '' : (groups[name] ?? ''));
    assert.equal(destination, target, `nginx sends /docs/${old} to ${destination}`);
  }
});
