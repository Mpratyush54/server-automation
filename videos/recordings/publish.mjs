#!/usr/bin/env node
// Upload processed clips to the Cloudflare R2 bucket behind
// https://media.cairnpaas.dev/v1/ and tell the landing page about them.
//
//   node publish.mjs upload  [clip...]   upload out/publish/<clip>.* (needs the aws CLI)
//   node publish.mjs check   [clip...]   fetch each file from the media host, check type and CORS
//   node publish.mjs versions            write landing-clip-versions.ts from the manifest
//
// Upload env: R2_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET, and an R2 API token's
// S3 keys in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Keys stay in the
// environment; nothing is written to disk.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, outDir } from './lib/config.mjs';

import { FILES, MEDIA_BASE, PREFIX, SITE_ORIGIN, versionsModule } from './lib/media.mjs';

const [command = '', ...rest] = process.argv.slice(2);
const publishDir = join(outDir(), 'publish');
const loadManifest = async () => JSON.parse(await readFile(join(publishDir, 'manifest.json'), 'utf8'));

async function clipsToUse() {
  const manifest = await loadManifest();
  const clips = rest.length ? rest : Object.keys(manifest.clips);
  for (const clip of clips) if (!manifest.clips[clip]) throw new Error(`${clip} is not in the manifest; run post/process.mjs first`);
  return { manifest, clips };
}

if (command === 'upload') {
  const { clips } = await clipsToUse();
  const endpoint = env('R2_ENDPOINT') ?? `https://${env('R2_ACCOUNT_ID', { required: true })}.r2.cloudflarestorage.com`;
  const bucket = env('R2_BUCKET', { required: true });
  env('AWS_ACCESS_KEY_ID', { required: true });
  env('AWS_SECRET_ACCESS_KEY', { required: true });
  for (const clip of clips) {
    for (const file of FILES) {
      const source = join(publishDir, `${clip}${file.suffix}`);
      const key = `${PREFIX}/${clip}${file.suffix}`;
      // URLs carry ?v=<content version>, so each cut can be cached for a year.
      const result = spawnSync('aws', ['s3', 'cp', source, `s3://${bucket}/${key}`, '--endpoint-url', endpoint, '--region', 'auto',
        '--content-type', file.type, '--cache-control', 'public, max-age=31536000, immutable', '--only-show-errors'], { stdio: 'inherit', env: { ...process.env, AWS_REGION: 'auto' } });
      if (result.error) throw new Error('The aws CLI is not installed');
      if (result.status !== 0) throw new Error(`Upload of ${key} failed`);
      console.log(`uploaded ${key}`);
    }
  }
} else if (command === 'check') {
  const { manifest, clips } = await clipsToUse();
  let problems = 0;
  for (const clip of clips) {
    for (const file of FILES) {
      const url = `${MEDIA_BASE}/${clip}${file.suffix}?v=${manifest.clips[clip].version}`;
      const response = await fetch(url, { method: 'HEAD', headers: { Origin: SITE_ORIGIN } });
      const type = response.headers.get('content-type') ?? '';
      const cors = response.headers.get('access-control-allow-origin');
      const ok = response.ok && type.startsWith(file.type.split(';')[0]) && (cors === '*' || cors === SITE_ORIGIN);
      if (!ok) problems++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${url}  ${response.status} ${type} cors=${cors}`);
    }
  }
  if (problems) {
    console.error(`${problems} problem(s). The bucket needs the CORS policy in r2-cors.json and the custom domain media.cairnpaas.dev.`);
    process.exit(1);
  }
} else if (command === 'versions') {
  const manifest = await loadManifest();
  const target = fileURLToPath(new URL('../../platform/portal/src/app/pages/landing/landing-clip-versions.ts', import.meta.url));
  await writeFile(target, versionsModule(manifest));
  console.log(`Wrote ${Object.keys(manifest.clips).length} clip version(s) to ${target}. Commit it to show the clips.`);
} else {
  console.error('Usage: node publish.mjs upload|check|versions [clip...]');
  process.exit(2);
}
