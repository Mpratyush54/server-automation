/**
 * Query scoping for the observability proxies (#48): every selector gets the
 * caller's project matcher and no query can read another project.
 */
import {
  buildLogQL, buildTraceQL, promSelector, pyroscopeQuery, QueryScopeError, scopeLogQL, scopePromQL, scopeTraceQL,
} from '../../../src/lib/observability-scope';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OWN = `platform_project_id="${A}"`;

/** Every `{...}` group of a PromQL/LogQL query (outside strings is good enough for these fixtures). */
function selectors(q: string): string[] {
  return q.match(/\{[^{}]*\}/g) || [];
}

function expectAllScoped(q: string) {
  const sels = selectors(q);
  expect(sels.length).toBeGreaterThan(0);
  for (const s of sels) expect(s).toContain(OWN);
  expect(q).not.toContain(B);
}

describe('scopePromQL', () => {
  it('injects the project matcher into bare and braced selectors', () => {
    expect(scopePromQL('up', A)).toBe(`up{${OWN}}`);
    expect(scopePromQL('http_requests_total{job="api"}', A)).toBe(`http_requests_total{job="api",${OWN}}`);
    expect(scopePromQL('{__name__=~".+"}', A)).toBe(`{__name__=~".+",${OWN}}`);
    expect(scopePromQL('{}', A)).toBe(`{${OWN}}`);
  });

  it('scopes every operand of or / unless / and and of nested functions', () => {
    for (const q of [
      'traces_spanmetrics_calls_total or secret_metric',
      'a unless on(job) b',
      'a and ignoring(instance) b',
      'sum by (service) (rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m])) / sum by (service) (rate(traces_spanmetrics_calls_total[5m]))',
      'histogram_quantile(0.95, sum by (le) (rate(traces_spanmetrics_latency_bucket[5m])))',
      'max_over_time(rate(x[5m])[1h:1m])',
      'label_replace(up, "platform_project_id", "B", "", "")',
      'count_values("v", up)',
      'a * on(job) group_left(team) b',
      'a * on(job) group_left b',
      'sum(rate(x[5m])) by (job) or vector(0)',
      'x offset 5m and y @ start()',
      'a > bool b',
      'topk(5, x) without (instance)',
    ]) {
      const out = scopePromQL(q, A);
      expectAllScoped(out);
    }
    expect(scopePromQL('a or b', A)).toBe(`a{${OWN}} or b{${OWN}}`);
    expect(scopePromQL('a * on(job) group_left b', A)).toBe(`a{${OWN}} * on(job) group_left b{${OWN}}`);
  });

  it('treats keywords used as metric names as selectors (fail closed)', () => {
    // Prometheus accepts some keywords as metric names; never leave them unscoped.
    expect(scopePromQL('sum', A)).toBe(`sum{${OWN}}`);
    expect(scopePromQL('or', A)).toBe(`or{${OWN}}`);
    expect(scopePromQL('offset', A)).toBe(`offset{${OWN}}`);
    expect(scopePromQL('bool', A)).toBe(`bool{${OWN}}`);
    expect(scopePromQL('group_left', A)).toBe(`group_left{${OWN}}`);
  });

  it('refuses label overrides of the project label', () => {
    for (const q of [
      `up{platform_project_id="${B}"}`,
      `up{platform_project_id!="${A}"}`,
      `up{platform_project_id=~".*"}`,
      `up{platform_project_id=~"${A}|${B}"}`,
      `up{platform_project_id="${A}", platform_project_id="${B}"}`,
      `up{"platform_project_id"="${B}"}`,
      `up{platform_project_id="${A}"} or up{platform_project_id="${B}"}`,
      `up{platform_project_id="\\x31111"}`,
    ]) {
      expect(() => scopePromQL(q, A)).toThrow(QueryScopeError);
    }
    // The caller's own id is accepted and not duplicated.
    expect(scopePromQL(`up{platform_project_id="${A}"}`, A)).toBe(`up{${OWN}}`);
  });

  it('refuses selector syntax it does not understand', () => {
    for (const q of [
      'up{job="a" or job="b"}',
      'up{job}',
      'up{job=a}',
      'up{"lbl\\x2e"="v"}',
      'up}',
      'up[5m',
      'rate(up[foo])',
      'sum by (rate(x[5m])) (y)',
      "up{job='a'} /* x */",
      'up // comment',
      'up; drop',
      'up\u0000',
      'x'.repeat(5000),
      '',
    ]) {
      expect(() => scopePromQL(q, A)).toThrow(QueryScopeError);
    }
  });

  it('does not see selectors inside strings and drops comments', () => {
    expect(scopePromQL('label_replace(up, "dst", "{x=\\"1\\"}", "src", "(.*)")', A))
      .toBe(`label_replace(up{${OWN}}, "dst", "{x=\\"1\\"}", "src", "(.*)")`);
    expect(scopePromQL(`up # {platform_project_id="${B}"}\n or down`, A)).toBe(`up{${OWN}} or down{${OWN}}`);
    expect(scopePromQL("up{job='a'}", A)).toBe(`up{job='a',${OWN}}`);
    expect(scopePromQL('up{job=`a`}', A)).toBe(`up{job=\`a\`,${OWN}}`);
  });

  it('a comment cannot swallow the injected matcher', () => {
    const out = scopePromQL('up#\n', A);
    expect(out).toBe(`up{${OWN}}`);
  });

  it('accepts Prometheus 3 quoted metric names', () => {
    expect(scopePromQL('{"my.metric", job="x"}', A)).toBe(`{"my.metric",job="x",${OWN}}`);
  });

  it('rejects invalid project ids', () => {
    expect(() => scopePromQL('up', 'not-a-uuid')).toThrow(QueryScopeError);
    expect(() => scopePromQL('up', `${A}"}`)).toThrow(QueryScopeError);
  });
});

describe('scopeLogQL', () => {
  it('stream mode: injects the matcher into every stream selector', () => {
    expect(scopeLogQL('{service_name="api"} |= "error"', A)).toBe(`{service_name="api",${OWN}} |= "error"`);
    expect(scopeLogQL('{} | json', A)).toBe(`{${OWN}} | json`);
    const metric = scopeLogQL('sum by (service_name) (rate({service_name="a"}[5m])) or sum(count_over_time({job="x"}[5m]))', A);
    expectAllScoped(metric);
    expect(scopeLogQL('rate({a="1"}[5m]) unless rate({b="2"}[5m])', A)).toBe(`rate({a="1",${OWN}}[5m]) unless rate({b="2",${OWN}}[5m])`);
  });

  it('pipeline stages cannot widen the selection', () => {
    const out = scopeLogQL(`{service_name="api"} | label_format platform_project_id="${B}" | line_format "{{.x}}"`, A);
    expect(out.startsWith(`{service_name="api",${OWN}}`)).toBe(true);
    // A pipeline filter on another project just narrows the already-scoped stream.
    expect(scopeLogQL(`{a="1"} | platform_project_id="${B}"`, A)).toBe(`{a="1",${OWN}} | platform_project_id="${B}"`);
  });

  it('refuses project label overrides and unknown syntax', () => {
    for (const q of [
      `{platform_project_id="${B}"}`,
      `{platform_project_id=~".+"}`,
      `{platform_project_id!=""}`,
      `{service_name="a", platform_project_id=~"${A}|${B}"}`,
      '{a="1" or b="2"}',
      `{"platform_project_id"="${B}"}`,
      "{a='1'}",
      'sum(rate(x[5m]))', // no stream selector
      '{a="1"} /* c */',
      '{a="1"}}',
      '{a="1"',
    ]) {
      expect(() => scopeLogQL(q, A)).toThrow(QueryScopeError);
    }
  });

  it('comments and strings cannot hide a selector', () => {
    expect(scopeLogQL(`{a="1"} # {platform_project_id="${B}"}`, A)).toBe(`{a="1",${OWN}}`);
    expect(scopeLogQL('{a="1"} |= "{b=\\"2\\"}"', A)).toBe(`{a="1",${OWN}} |= "{b=\\"2\\"}"`);
    expect(scopeLogQL('{a="1"} |= `}{`', A)).toBe(`{a="1",${OWN}} |= \`}{\``);
  });

  it('metadata mode: filters on the project right after each selector', () => {
    expect(scopeLogQL('{service_name="api"} | json', A, 'metadata')).toBe(`{service_name="api"} | ${OWN} | json`);
    expect(scopeLogQL('{}', A, 'metadata')).toBe(`{service_name=~".+"} | ${OWN}`);
    expect(scopeLogQL('count_over_time({a="1"}[5m])', A, 'metadata')).toBe(`count_over_time({a="1"} | ${OWN}[5m])`);
    expect(() => scopeLogQL(`{platform_project_id="${B}"}`, A, 'metadata')).toThrow(QueryScopeError);
  });
});

describe('scopeTraceQL', () => {
  const own = `resource.platform.project_id = "${A}"`;

  it('wraps every spanset filter', () => {
    expect(scopeTraceQL('{}', A)).toBe(`{ ${own} }`);
    expect(scopeTraceQL('{ span.http.status_code >= 500 }', A)).toBe(`{ ${own} && ( span.http.status_code >= 500 ) }`);
    const out = scopeTraceQL('{ .a = 1 } || { .b = 2 } >> { status = error } | count() > 2', A);
    expect(out.match(new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(3);
  });

  it('or-conditions and negations stay inside the project', () => {
    expect(scopeTraceQL(`{ resource.platform.project_id = "${B}" || true }`, A))
      .toBe(`{ ${own} && ( resource.platform.project_id = "${B}" || true ) }`);
    expect(scopeTraceQL(`{ !(resource.platform.project_id = "${A}") }`, A))
      .toBe(`{ ${own} && ( !(resource.platform.project_id = "${A}") ) }`);
  });

  it('refuses parentheses that would escape the wrapper', () => {
    for (const q of [
      '{ true) || (true }',
      '{ ) || ( }',
      '{ (true }',
      '{ { nested } }',
      '{ true',
      'true }',
      '{ .a = "x" } // }',
      '{ .a = 1 /* } */ }',
      "{ .a = '}' }",
      '{ .a = 1 } # x',
      '{ .a = "unterminated }',
      'count() > 1',
    ]) {
      expect(() => scopeTraceQL(q, A)).toThrow(QueryScopeError);
    }
  });

  it('braces and parens inside strings are data', () => {
    expect(scopeTraceQL('{ name = "GET /a) || (true }" }', A)).toBe(`{ ${own} && ( name = "GET /a) || (true }" ) }`);
    expect(scopeTraceQL('{ name = `x)}` }', A)).toBe(`{ ${own} && ( name = \`x)}\` ) }`);
    expect(scopeTraceQL('{ name = "a\\"b) || (c" }', A)).toBe(`{ ${own} && ( name = "a\\"b) || (c" ) }`);
  });
});

describe('server-built queries', () => {
  it('promSelector escapes values and never overrides the project label', () => {
    expect(promSelector(A, { service: 'a"} or vector(1) #' })).toBe(`{${OWN},service="a\\"} or vector(1) #"}`);
    expect(() => promSelector(A, { platform_project_id: B })).toThrow(QueryScopeError);
    expect(() => promSelector(A, { 'bad label': 'x' })).toThrow(QueryScopeError);
    // A malicious service value stays inside one string literal: re-scoping is a fixed point.
    const sel = promSelector(A, { service: 'x"} or up{a="' });
    expect(scopePromQL(`up${sel}`, A)).toBe(`up{service="x\\"} or up{a=\\"",${OWN}}`);
  });

  it('buildTraceQL quotes values and validates durations / status', () => {
    const q = buildTraceQL({ service: 'svc" } || { true', minDuration: '100ms', status: 'error' });
    expect(q).toBe('{ resource.service.name = "svc\\" } || { true" && duration >= 100ms && status = error }');
    expect(scopeTraceQL(q, A).startsWith(`{ resource.platform.project_id = "${A}" && (`)).toBe(true);
    expect(() => buildTraceQL({ minDuration: '1s } || {' })).toThrow(QueryScopeError);
    expect(() => buildTraceQL({ status: 'error || true' })).toThrow(QueryScopeError);
  });

  it('buildLogQL quotes values; the result scopes cleanly', () => {
    const q = buildLogQL({ service: 'api"}', search: '"} or {a="1', traceId: 'ABCDEF0123456789abcdef0123456789', level: 'error' });
    const scoped = scopeLogQL(q, A);
    expect(selectors(scoped.replace(/"(?:[^"\\]|\\.)*"/g, '""')).length).toBe(1);
    expect(scoped).toContain(OWN);
    expect(scoped).toContain('trace_id="abcdef0123456789abcdef0123456789"');
    expect(() => buildLogQL({ traceId: 'zz' })).toThrow(QueryScopeError);
    expect(() => buildLogQL({ level: 'error"' })).toThrow(QueryScopeError);
  });

  it('pyroscopeQuery builds a scoped selector and validates the profile type', () => {
    expect(pyroscopeQuery(A, 'process_cpu:cpu:nanoseconds:cpu:nanoseconds', 'api', 'production'))
      .toBe(`process_cpu:cpu:nanoseconds:cpu:nanoseconds{${OWN},platform_service="api",deployment_environment="production"}`);
    expect(() => pyroscopeQuery(A, 'process_cpu{platform_project_id="x"}', null, null)).toThrow(QueryScopeError);
    expect(() => pyroscopeQuery(A, 'a:b:c:d:e', null, null)).not.toThrow();
  });
});
