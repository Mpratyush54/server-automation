import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { upload } from './platform-sourcemaps.mjs';

test('CI uploader walks map files, derives public asset paths and refuses insecure credential delivery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maps-test-'));
  const env = { PLATFORM_API_URL: 'https://platform.example.test', PLATFORM_CI_TOKEN: 'test-token' };
  const calls = [];
  try {
    await mkdir(path.join(dir, 'chunks'));
    await writeFile(path.join(dir, 'chunks', 'app.js.map'), '{"version":3,"sources":[],"names":[],"mappings":""}');
    await writeFile(path.join(dir, 'app.js'), 'minified');
    assert.equal(await upload(['upload', 'project', '1.2.0', dir, '/assets'], env, async (url, init) => {
      calls.push({ url, init }); return { ok: true };
    }), 1);
    assert.equal(calls[0].url, 'https://platform.example.test/api/projects/project/releases/1.2.0/sourcemaps');
    assert.equal(JSON.parse(calls[0].init.body).file, '/assets/chunks/app.js');
    assert.equal(calls[0].init.redirect, 'error');
    await assert.rejects(upload(['upload', 'project', '1', dir], { ...env, PLATFORM_API_URL: 'http://untrusted.test' }), /HTTPS/);
    await assert.rejects(upload(['upload', 'project', '1', dir], env, async () => ({ ok: false, status: 403 })), /403/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
