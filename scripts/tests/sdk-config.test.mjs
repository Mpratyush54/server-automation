import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from '../../examples/sdk-apps/node-api/src/config.cjs';

const env = { PLATFORM_URL: 'https://platform.example.com/', PROJECT_DOMAIN: '203.0.113.10.sslip.io', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-only' };

test('VM configuration comes entirely from env and supports legacy URL alias', () => {
  assert.deepEqual(config.readE2EConfig(env), { platformUrl: 'https://platform.example.com', projectDomain: env.PROJECT_DOMAIN, adminEmail: env.ADMIN_EMAIL, adminPassword: env.ADMIN_PASSWORD });
  assert.equal(config.readConfig({ ...env, PLATFORM_URL: '', PLATFORM_API_URL: 'http://localhost:3000' }).platformUrl, 'http://localhost:3000');
});

test('missing configuration and invalid URLs/domains fail before connecting', () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => config.readE2EConfig({ ...env, [name]: ' ' }), new RegExp(name));
  }
  for (const url of ['not-a-url', 'ftp://example.com', 'https://example.com/api', 'https://user:pass@example.com', 'https://example.com?x=1']) {
    assert.throws(() => config.readConfig({ ...env, PLATFORM_URL: url }), /PLATFORM_URL/);
  }
  for (const domain of ['https://example.com', '<your-ip>.sslip.io', 'example.com/path', '-bad.example.com']) {
    assert.throws(() => config.readConfig({ ...env, PROJECT_DOMAIN: domain }), /PROJECT_DOMAIN/);
  }
});

test('demo and every E2E entrypoint fail helpfully without dependencies or network', () => {
  for (const file of ['examples/sdk-apps/node-api/src/index.js', ...['live', 'gitops', 'telemetry'].map(name => `scripts/e2e-sdk-${name}.mjs`)]) {
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, PLATFORM_URL: '', PLATFORM_API_URL: '', PROJECT_DOMAIN: '' } });
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /PLATFORM_URL is required/, file);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/, file);
  }
});

test('demo passes the configured VM URL and domain to SDK registration', () => {
  const entry = fileURLToPath(new URL('../../examples/sdk-apps/node-api/src/index.js', import.meta.url));
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'express' || name === 'cors') return {};
      if (name === '@mpratyush54/sdk-node') return { init(options) {
        assert.equal(options.platformUrl, 'https://platform.example.com');
        assert.equal(options.domain, '203.0.113.10.sslip.io');
        assert.equal(options.sdkToken, 'test-only');
        process.exit(0);
      } };
      return load.call(this, name, ...args);
    };
    require(process.argv[1]);
  `;
  const result = spawnSync(process.execPath, ['-e', script, entry], {
    encoding: 'utf8', env: { ...process.env, ...env, PLATFORM_SDK_TOKEN: 'test-only' },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('changed documentation is identical in both doc trees', () => {
  for (const file of ['getting-started/node-sdk-quickstart.md', 'mcp/setup.md']) {
    assert.equal(readFileSync(`docs/${file}`, 'utf8'), readFileSync(`platform/portal/public/docs/${file}`, 'utf8'));
  }
});
