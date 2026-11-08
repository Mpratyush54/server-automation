// node --test scripts/nginx-headers.test.mjs
// nginx drops server-level add_header directives inside any location that
// declares its own add_header, so check every such location repeats the
// security headers, and that the CSP stays compatible with the build output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const portal = fileURLToPath(new URL('../', import.meta.url));
const SECURITY_HEADERS = [
  'Content-Security-Policy',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
];

/** Split a single-server nginx config into the server body and its location blocks. */
function blocks(conf) {
  const lines = conf.split('\n');
  const server = [];
  const locations = [];
  let current = null;
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (!current && depth === 1 && /^location\b.*\{$/.test(trimmed)) {
      current = { head: trimmed, body: [] };
      depth += 1;
      continue;
    }
    const opens = (line.match(/\{/g) || []).length - (line.match(/\{\d+,?\d*\}/g) || []).length;
    const closes = (line.match(/\}/g) || []).length - (line.match(/\{\d+,?\d*\}/g) || []).length;
    depth += opens - closes;
    if (current) {
      if (depth === 1) {
        locations.push(current);
        current = null;
      } else {
        current.body.push(trimmed);
      }
    } else if (depth >= 1) {
      server.push(trimmed);
    }
  }
  return { server, locations };
}

function headers(directives) {
  const found = new Map();
  for (const d of directives) {
    const m = d.match(/^add_header\s+(\S+)\s+("[^"]*"|'[^']*'|\S+)(\s+always)?;$/);
    if (m) found.set(m[1], { value: m[2].replace(/^["']|["']$/g, ''), always: !!m[3] });
  }
  return found;
}

function assertSecurityHeaders(directives, where, frameAncestors) {
  const found = headers(directives);
  for (const name of SECURITY_HEADERS) {
    assert.ok(found.has(name), `${where}: missing ${name}`);
    assert.ok(found.get(name).always, `${where}: ${name} must use "always"`);
  }
  assert.equal(found.get('X-Content-Type-Options').value, 'nosniff', where);
  assert.equal(found.get('Referrer-Policy').value, 'strict-origin-when-cross-origin', where);
  const csp = found.get('Content-Security-Policy').value;
  assert.match(csp, new RegExp(`frame-ancestors ${frameAncestors}`), `${where}: frame-ancestors`);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-(inline|eval)'/, `${where}: script-src must not allow inline/eval`);
  assert.match(csp, /object-src 'none'|default-src 'none'/, `${where}: plugins must be blocked`);
}

for (const [file, frameAncestors] of [['nginx.conf', "'self'"], ['nginx.public.conf', "'none'"]]) {
  test(`${file}: server and every add_header location send the security headers`, async () => {
    const { server, locations } = blocks(await readFile(portal + file, 'utf8'));
    assertSecurityHeaders(server, `${file} server`, frameAncestors);
    let checked = 0;
    for (const location of locations) {
      if (!location.body.some((d) => d.startsWith('add_header'))) continue;
      checked += 1;
      // /api/ deliberately uses a stricter API policy, still framed by 'self' only.
      const expected = location.head.startsWith('location /api/') ? "'self'" : frameAncestors;
      assertSecurityHeaders(location.body, `${file} ${location.head}`, expected);
    }
    assert.ok(checked > 0 || file === 'nginx.conf', `${file}: expected locations with add_header`);
  });
}

test('production build emits no inline event handlers blocked by script-src', async () => {
  // Critical-CSS inlining adds <link ... onload="this.media='all'">, which
  // script-src 'self' blocks, leaving the main stylesheet stuck on media=print.
  const angular = JSON.parse(await readFile(portal + 'angular.json', 'utf8'));
  const optimization = angular.projects.portal.architect.build.configurations.production.optimization;
  assert.equal(optimization?.styles?.inlineCritical, false);
});
