#!/usr/bin/env node
// CI: PLATFORM_API_URL, PLATFORM_CI_TOKEN (project-scoped agent token).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function upload(args, env = process.env, request = fetch) {
  const [command, project, release, directory, urlPrefix = '/'] = args;
  if (command !== 'upload' || !project || !release || !directory || !env.PLATFORM_API_URL || !env.PLATFORM_CI_TOKEN) {
    throw new Error('Usage: platform-sourcemaps upload PROJECT_UUID RELEASE DIST_DIR [PUBLIC_PATH]; set PLATFORM_API_URL and PLATFORM_CI_TOKEN');
  }
  const base = new URL(env.PLATFORM_API_URL);
  if (base.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(base.hostname) && base.protocol === 'http:')) throw new Error('CI upload requires HTTPS');
  let count = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file.endsWith('.map')) {
        const rel = path.relative(directory, file).replaceAll('\\', '/').slice(0, -4);
        const map = JSON.parse(await readFile(file, 'utf8'));
        const result = await request(`${base.href.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project)}/releases/${encodeURIComponent(release)}/sourcemaps`, {
          method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${env.PLATFORM_CI_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: urlPrefix.replace(/\/$/, '') + '/' + rel, map }),
        });
        if (!result.ok) throw new Error(`Upload failed (${result.status}): ${rel}`);
        count++;
      }
    }
  }
  await walk(directory);
  if (!count) throw new Error('No .map files found');
  return count;
}
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  upload(process.argv.slice(2)).then(n => console.log(`Uploaded ${n} source maps`)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
