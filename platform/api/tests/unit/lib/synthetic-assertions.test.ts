import {
  evaluateAssertion, evaluateAssertions, extractVariables, jsonPathGet, parseJsonPath, redactSecrets,
  referencedSecrets, renderTemplate, ResponseView, validateRegex,
} from '../../../src/lib/synthetic-assertions';

const res = (over: Partial<ResponseView> = {}): ResponseView => ({
  status: 200,
  latencyMs: 120,
  headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'abc' },
  body: JSON.stringify({ status: 'ok', data: { items: [{ id: 7, name: 'first' }], count: 1, 'odd key': true }, nothing: null }),
  sslDaysRemaining: 30,
  ...over,
});

describe('assertion engine', () => {
  it('status / latency numeric comparisons', () => {
    expect(evaluateAssertion({ source: 'status', comparison: 'eq', target: 200 }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'status', comparison: 'eq', target: '200' }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'status', comparison: 'lt', target: 400 }, res({ status: 503 })).passed).toBe(false);
    expect(evaluateAssertion({ source: 'latency', comparison: 'lte', target: 120 }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'latency', comparison: 'gt', target: 500 }, res()).passed).toBe(false);
    expect(evaluateAssertion({ source: 'status', comparison: 'neq', target: 500 }, res()).passed).toBe(true);
  });

  it('headers are case-insensitive and support exists / contains', () => {
    expect(evaluateAssertion({ source: 'header', property: 'Content-Type', comparison: 'contains', target: 'application/json' }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'header', property: 'X-Missing', comparison: 'not_exists' }, res()).passed).toBe(true);
    const missing = evaluateAssertion({ source: 'header', property: 'X-Missing', comparison: 'eq', target: 'x' }, res());
    expect(missing).toMatchObject({ passed: false, message: 'value not found' });
  });

  it('JSON path assertions', () => {
    expect(evaluateAssertion({ source: 'json', property: '$.status', comparison: 'eq', target: 'ok' }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'json', property: '$.data.items[0].id', comparison: 'eq', target: 7 }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'json', property: '$.data["odd key"]', comparison: 'eq', target: true }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'json', property: '$.data.count', comparison: 'gte', target: 1 }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'json', property: '$.nothing', comparison: 'exists' }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'json', property: '$.nothing', comparison: 'eq', target: null }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'json', property: '$.data.items[3]', comparison: 'exists' }, res()).passed).toBe(false);
    expect(evaluateAssertion({ source: 'json', property: '$.status', comparison: 'eq', target: 'ok' }, res({ body: '<html>' })))
      .toMatchObject({ passed: false, message: 'response body is not JSON' });
  });

  it('body contains / regex, without storing the body', () => {
    const r = evaluateAssertion({ source: 'body', comparison: 'contains', target: '"status":"ok"' }, res());
    expect(r.passed).toBe(true);
    expect(r.actual).toBeNull();
    expect(evaluateAssertion({ source: 'body', comparison: 'not_contains', target: 'error' }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'body', comparison: 'matches', target: '"id":\\s*7' }, res()).passed).toBe(true);
  });

  it('ssl_days source', () => {
    expect(evaluateAssertion({ source: 'ssl_days', comparison: 'gt', target: 14 }, res()).passed).toBe(true);
    expect(evaluateAssertion({ source: 'ssl_days', comparison: 'gt', target: 14 }, res({ sslDaysRemaining: null })).passed).toBe(false);
  });

  it('all assertions must pass', () => {
    const out = evaluateAssertions([
      { source: 'status', comparison: 'eq', target: 200 },
      { source: 'latency', comparison: 'lt', target: 100 },
    ], res());
    expect(out.passed).toBe(false);
    expect(out.results.map((r) => r.passed)).toEqual([true, false]);
    expect(out.results[1].actual).toBe('120');
  });

  it('refuses dangerous regular expressions', () => {
    expect(validateRegex('(a+)+$')).toMatch(/nested/);
    expect(validateRegex('(\\w*)*x')).toMatch(/nested/);
    expect(validateRegex('(a)\\1')).toMatch(/back-references/);
    expect(validateRegex('x'.repeat(201))).toMatch(/longer/);
    expect(validateRegex('[')).toMatch(/invalid/);
    expect(validateRegex('^ok$')).toBeNull();
    expect(evaluateAssertion({ source: 'body', comparison: 'matches', target: '(a+)+$' }, res()).passed).toBe(false);
  });
});

describe('json path', () => {
  it('parses dots, brackets and quoted keys', () => {
    expect(parseJsonPath('$.a.b[2]["c d"]')).toEqual(['a', 'b', 2, 'c d']);
    expect(parseJsonPath('a.b')).toEqual(['a', 'b']);
    expect(parseJsonPath('$.a[*]')).toBeNull();
    expect(jsonPathGet({ a: { b: [1, 2, 3] } }, '$.a.b[1]')).toEqual({ found: true, value: 2 });
    expect(jsonPathGet({ a: 1 }, '$.__proto__')).toEqual({ found: false, value: undefined });
  });
});

describe('variables', () => {
  it('extracts from JSON, headers, regex and status', () => {
    const out = extractVariables([
      { name: 'id', source: 'json', property: '$.data.items[0].id' },
      { name: 'item', source: 'json', property: '$.data.items[0]' },
      { name: 'rid', source: 'header', property: 'X-Request-Id' },
      { name: 'name', source: 'body_regex', property: '"name":"(\\w+)"' },
      { name: 'code', source: 'status' },
      { name: 'gone', source: 'json', property: '$.missing' },
    ], res());
    expect(out.values).toEqual({ id: '7', item: '{"id":7,"name":"first"}', rid: 'abc', name: 'first', code: '200' });
    expect(out.missing).toEqual(['gone']);
  });

  it('renders {{var}} and {{secret.NAME}}, reporting unknown names', () => {
    const r = renderTemplate('Bearer {{ token }} / {{secret.KEY}} / {{nope}} / {{secret.NOPE}}', { token: 't1' }, { KEY: 's3cr3t' });
    expect(r.value).toBe('Bearer t1 / s3cr3t / {{nope}} / {{secret.NOPE}}');
    expect(r.unknown).toEqual(['nope', 'secret.NOPE']);
    // A variable can never read a secret by name.
    expect(renderTemplate('{{KEY}}', {}, { KEY: 'x' }).unknown).toEqual(['KEY']);
    expect(referencedSecrets('{{secret.A}} {{b}}', 'x {{ secret.C }}')).toEqual(['A', 'C']);
  });

  it('redacts secret values from stored text', () => {
    expect(redactSecrets('login failed for hunter22 at host', { P: 'hunter22', short: 'ab' })).toBe('login failed for [redacted] at host');
  });
});
