import { runCheck, runMultistep, runSsl } from '../../../src/lib/synthetic-runner';
import type { HttpRequestSpec, HttpResponseResult } from '../../../src/lib/synthetic-http';
import { SsrfError } from '../../../src/lib/synthetic-ssrf';

function response(over: Partial<HttpResponseResult> = {}): HttpResponseResult {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}', truncated: false, latencyMs: 15, redirects: 0, finalUrl: '', address: '93.184.216.34', tls: null, ...over };
}

describe('multi-step API checks', () => {
  const login = {
    name: 'Login', method: 'POST', url: 'https://api.example.com/login',
    headers: { 'Content-Type': 'application/json' }, body: '{"u":"{{secret.USER}}","p":"{{secret.PASSWORD}}"}',
    assertions: [{ source: 'status', comparison: 'eq', target: 200 }],
    extract: [{ name: 'token', source: 'json', property: '$.token' }, { name: 'uid', source: 'json', property: '$.user.id' }],
  };
  const profile = {
    name: 'Profile', method: 'GET', url: 'https://api.example.com/users/{{uid}}',
    headers: { Authorization: 'Bearer {{token}}' },
    assertions: [{ source: 'json', property: '$.name', comparison: 'eq', target: 'Ada' }],
    extract: [],
  };
  const secrets = { USER: 'ada@example.com', PASSWORD: 'correct-horse' };

  it('extracts variables from one step and uses them in the next', async () => {
    const calls: HttpRequestSpec[] = [];
    const http = async (spec: HttpRequestSpec) => {
      calls.push(spec);
      if (spec.url.endsWith('/login')) return response({ body: JSON.stringify({ token: 'tok-123', user: { id: 42 } }) });
      return response({ body: JSON.stringify({ name: 'Ada' }) });
    };
    const out = await runMultistep({ id: 'c', type: 'multistep', timeoutMs: 10_000, config: { steps: [login, profile] } }, { guard: {}, secrets, http });
    expect(out.status).toBe('pass');
    expect(calls[0].body).toBe('{"u":"ada@example.com","p":"correct-horse"}');
    expect(calls[1].url).toBe('https://api.example.com/users/42');
    expect(calls[1].headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(out.steps!.map((s) => s.status)).toEqual(['pass', 'pass']);
    expect(out.steps![0].extracted).toEqual(['token', 'uid']);
    // Neither secrets nor extracted values are stored.
    const stored = JSON.stringify(out);
    expect(stored).not.toContain('correct-horse');
    expect(stored).not.toContain('tok-123');
  });

  it('fails on a missing extraction and skips the remaining steps', async () => {
    const http = async () => response({ body: '{"nope":true}' });
    const out = await runMultistep({ id: 'c', type: 'multistep', timeoutMs: 10_000, config: { steps: [login, profile] } }, { guard: {}, secrets, http });
    expect(out.status).toBe('fail');
    expect(out.error).toMatch(/could not extract: token, uid/);
    expect(out.steps!.map((s) => s.status)).toEqual(['fail', 'skipped']);
  });

  it('refuses a flow whose host would change via an extracted variable', async () => {
    // Save-time validation already refuses templated hosts; this is the runtime backstop.
    const step = { name: 'Next', method: 'GET', url: 'https://api.example.com{{next}}/', headers: {}, assertions: [], extract: [] };
    const first = { ...login, extract: [{ name: 'next', source: 'json', property: '$.next' }] };
    const http = jest.fn(async () => response({ body: '{"next":".evil.example"}' }));
    const out = await runMultistep({ id: 'c', type: 'multistep', timeoutMs: 10_000, config: { steps: [first, step] } }, { guard: {}, secrets, http });
    expect(http).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('fail');
    expect(out.error).toMatch(/host changed/);
  });

  it('records SSRF refusals as failures with the secret redacted', async () => {
    const http = async () => { throw new SsrfError('target for correct-horse resolves to a private address', 'private_address'); };
    const out = await runMultistep({ id: 'c', type: 'multistep', timeoutMs: 10_000, config: { steps: [login] } }, { guard: {}, secrets, http });
    expect(out.status).toBe('fail');
    expect(out.error).toContain('[redacted]');
    expect(out.error).not.toContain('correct-horse');
  });

  it('unknown template variables fail the step without a request', async () => {
    const http = jest.fn(async () => response());
    const out = await runMultistep({ id: 'c', type: 'multistep', timeoutMs: 10_000, config: { steps: [profile] } }, { guard: {}, secrets: {}, http });
    expect(http).not.toHaveBeenCalled();
    expect(out.error).toMatch(/unknown variables uid, token/);
  });
});

describe('HTTP checks', () => {
  it('default assertion is status < 400 and secrets fill headers', async () => {
    let sent: any;
    const http = async (spec: HttpRequestSpec) => { sent = spec; return response({ status: 503 }); };
    const out = await runCheck({ id: 'c', type: 'http', timeoutMs: 5000, config: { url: 'https://x.example/', method: 'GET', headers: { 'X-Key': '{{secret.K}}' }, assertions: [] } }, { guard: {}, secrets: { K: 'val-1234' }, http });
    expect(sent.headers).toEqual({ 'X-Key': 'val-1234' });
    expect(out).toMatchObject({ status: 'fail', statusCode: 503 });
    expect(out.assertions![0]).toMatchObject({ source: 'status', comparison: 'lt', target: 400, passed: false, actual: '503' });
  });

  it('records certificate expiry seen on https', async () => {
    const http = async () => response({ tls: { validTo: '2030-01-01T00:00:00.000Z', daysRemaining: 400, authorized: true, authorizationError: null, issuer: 'CA', subject: 'x' } });
    const out = await runCheck({ id: 'c', type: 'http', timeoutMs: 5000, config: { url: 'https://x.example/', method: 'GET', assertions: [] } }, { guard: {}, secrets: {}, http });
    expect(out.status).toBe('pass');
    expect(out.sslExpiresAt!.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('SSL checks', () => {
  const cfg = { host: 'x.example', port: 443, warnDays: 14, criticalDays: 0 };
  const tls = (daysRemaining: number, authorized = true) => async () => ({
    validTo: new Date(Date.now() + daysRemaining * 86_400_000).toISOString(), daysRemaining, authorized,
    authorizationError: authorized ? null : 'SELF_SIGNED', issuer: 'CA', subject: 'x.example', latencyMs: 5,
  });
  it('passes with plenty of time left', async () => {
    expect((await runSsl({ id: 'c', type: 'ssl', timeoutMs: 5000, config: cfg }, { guard: {}, secrets: {}, tls: tls(60) })).status).toBe('pass');
  });
  it('warns (degraded) 14 days before expiry', async () => {
    const out = await runSsl({ id: 'c', type: 'ssl', timeoutMs: 5000, config: cfg }, { guard: {}, secrets: {}, tls: tls(14) });
    expect(out.status).toBe('degraded');
    expect(out.error).toMatch(/expires in 14 day/);
    expect((await runSsl({ id: 'c', type: 'ssl', timeoutMs: 5000, config: cfg }, { guard: {}, secrets: {}, tls: tls(15) })).status).toBe('pass');
  });
  it('fails when expired or untrusted', async () => {
    expect((await runSsl({ id: 'c', type: 'ssl', timeoutMs: 5000, config: cfg }, { guard: {}, secrets: {}, tls: tls(-1) })).error).toBe('Certificate expired');
    expect((await runSsl({ id: 'c', type: 'ssl', timeoutMs: 5000, config: cfg }, { guard: {}, secrets: {}, tls: tls(90, false) })).status).toBe('fail');
  });
});
