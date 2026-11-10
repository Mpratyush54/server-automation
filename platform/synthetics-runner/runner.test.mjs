// node --test runner.test.mjs (no browser needed: only the pure helpers are tested).
import test from 'node:test';
import assert from 'node:assert/strict';
import { render, requestAllowed } from './runner.mjs';

test('blocks internal and non-HTTP requests', () => {
  for (const url of [
    'http://localhost:3000/', 'http://platform-api.platform.svc:3000/api', 'http://10.43.0.1/', 'http://169.254.169.254/latest',
    'http://[::1]/', 'http://[fd00::1]/', 'http://192.168.1.1/', 'file:///etc/passwd', 'ftp://example.com/', 'http://intranet/',
    'https://user:pw@example.com/', 'http://kubernetes.default.svc.cluster.local/',
  ]) assert.equal(requestAllowed(url), false, url);
});

test('allows public pages, inline resources and the project ingress host', () => {
  for (const url of ['https://example.com/', 'http://93.184.216.34/x', 'data:image/png;base64,AAAA', 'about:blank']) {
    assert.equal(requestAllowed(url), true, url);
  }
  assert.equal(requestAllowed('https://app.internal/', ['app.internal']), true);
});

test('renders secrets and leaves unknown names untouched', () => {
  assert.equal(render('pw={{secret.PW}} x={{secret.NOPE}}', { PW: 'p1' }), 'pw=p1 x={{secret.NOPE}}');
});
