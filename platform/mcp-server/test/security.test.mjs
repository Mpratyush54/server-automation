// Regression tests for MCP secret handling and request timeouts.
// Run with: npm test  (builds first, then node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PlatformClient, PlatformApiError } from '../dist/client.js';
import { registerTools } from '../dist/tools/index.js';
import { redactSecrets } from '../dist/redact.js';

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function loginServer() {
  const seen = [];
  return startServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login') {
      res.end(JSON.stringify({ token: FAKE_JWT, user: { id: 'u1', email: 'a@example.com', role: 'admin' } }));
    } else if (req.url === '/api/users/me') {
      res.end(JSON.stringify({ id: 'u1', email: 'a@example.com' }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  }).then((s) => ({ ...s, seen }));
}

test('platform_login does not return the JWT in the tool result', async () => {
  const { server, baseUrl, seen } = await loginServer();
  try {
    const client = new PlatformClient({ baseUrl });
    const tools = registerTools(client);
    const login = tools.find((t) => t.name === 'platform_login');
    const result = await login.handler({ email: 'a@example.com', password: 'pw-123456' });
    const text = result.content[0].text;
    assert.equal(result.isError, undefined);
    assert.ok(!text.includes(FAKE_JWT), 'JWT leaked into tool result');
    assert.ok(!text.includes('pw-123456'), 'password leaked into tool result');
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.user.email, 'a@example.com');
    assert.equal('token' in parsed, false);

    // The JWT is still kept in memory and used for subsequent calls.
    assert.equal(client.hasHumanJwt(), true);
    await client.whoami();
    assert.equal(seen.at(-1).auth, `Bearer ${FAKE_JWT}`);
  } finally {
    server.close();
  }
});

test('tool results and errors redact token-shaped values and secret keys', () => {
  const out = redactSecrets({
    token: FAKE_JWT,
    nested: { password: 'hunter2', dbPassword: 'x', webhookSecret: 'y', name: 'ok' },
    logs: `got Authorization: Bearer ${FAKE_JWT} and plat_agent_abc123 and sdk_live_deadbeef`,
    tokenInfo: { token: { id: 't1', name: 'ci' } },
    list: [{ apiKey: 'k' }],
  });
  const text = JSON.stringify(out);
  for (const secret of [FAKE_JWT, 'hunter2', 'plat_agent_abc123', 'sdk_live_deadbeef']) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
  assert.equal(out.nested.name, 'ok');
  assert.equal(out.tokenInfo.token.id, 't1');
  assert.equal(out.list[0].apiKey, '[REDACTED]');
});

test('API error bodies echoing secrets are redacted in toolError output', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'bad', token: FAKE_JWT }));
  });
  try {
    const client = new PlatformClient({ baseUrl, agentToken: 'plat_agent_testtoken' });
    const tools = registerTools(client);
    const result = await tools.find((t) => t.name === 'platform_list_projects').handler({});
    assert.equal(result.isError, true);
    assert.ok(!result.content[0].text.includes(FAKE_JWT));
  } finally {
    server.close();
  }
});

test('requests time out instead of hanging forever', async () => {
  const { server, baseUrl } = await startServer(() => {
    /* never respond */
  });
  try {
    const client = new PlatformClient({ baseUrl, timeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(client.health(), (err) => {
      assert.ok(err instanceof PlatformApiError);
      assert.equal(err.status, 504);
      assert.match(err.message, /timed out after 200ms/);
      return true;
    });
    assert.ok(Date.now() - started < 5000);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
