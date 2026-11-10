import {
  AssertionResult, DEFAULT_ASSERTIONS, evaluateAssertions, extractVariables, redactSecrets, renderTemplate, ResponseView,
} from './synthetic-assertions';
import { HttpRequestSpec, HttpResponseResult, syntheticHttpRequest, syntheticTlsProbe, TlsInfo } from './synthetic-http';
import { GuardOptions } from './synthetic-ssrf';
import type { SyntheticResultStatus } from '../entities/SyntheticResult';

/**
 * In-process runner for HTTP, multi-step API and SSL checks (#42). Browser checks run in
 * Kubernetes CronJobs (lib/synthetic-k8s) and report through the runner API instead.
 * Everything that is stored is passed through redactSecrets first.
 */

export interface RunOutcome {
  status: SyntheticResultStatus;
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
  assertions: AssertionResult[] | null;
  steps: StepOutcome[] | null;
  sslExpiresAt: Date | null;
  sslDaysRemaining: number | null;
}

export interface StepOutcome {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  latencyMs: number | null;
  statusCode: number | null;
  error?: string;
  assertions?: AssertionResult[];
  /** Names of variables this step extracted (values are not stored). */
  extracted?: string[];
}

export interface RunnableCheck {
  id: string;
  type: string;
  timeoutMs: number;
  config: Record<string, any>;
}

export interface RunDeps {
  guard: GuardOptions;
  secrets: Record<string, string>;
  http?: (spec: HttpRequestSpec, guard: GuardOptions) => Promise<HttpResponseResult>;
  tls?: (host: string, port: number, timeoutMs: number, guard: GuardOptions) => Promise<TlsInfo & { latencyMs: number }>;
  now?: () => number;
}

function view(res: HttpResponseResult): ResponseView {
  return {
    status: res.status,
    latencyMs: res.latencyMs,
    headers: res.headers,
    body: res.body,
    sslDaysRemaining: res.tls?.daysRemaining ?? null,
  };
}

function renderAll(values: Record<string, string>, vars: Record<string, string>, secrets: Record<string, string>, unknown: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const r = renderTemplate(v, vars, secrets);
    unknown.push(...r.unknown);
    out[k] = r.value;
  }
  return out;
}

function errorText(err: any, secrets: Record<string, string>): string {
  return redactSecrets(String(err?.message || err || 'error'), secrets).slice(0, 1000);
}

function tlsExpiry(tls: TlsInfo | null | undefined): Date | null {
  return tls?.validTo ? new Date(tls.validTo) : null;
}

async function runHttp(check: RunnableCheck, deps: RunDeps): Promise<RunOutcome> {
  const c = check.config;
  const http = deps.http || syntheticHttpRequest;
  const unknown: string[] = [];
  const url = renderTemplate(c.url, {}, deps.secrets);
  unknown.push(...url.unknown);
  const headers = renderAll(c.headers || {}, {}, deps.secrets, unknown);
  const body = c.body !== undefined ? renderTemplate(c.body, {}, deps.secrets) : undefined;
  if (body) unknown.push(...body.unknown);
  if (unknown.length) {
    return { status: 'fail', latencyMs: null, statusCode: null, error: `Unknown template values: ${[...new Set(unknown)].join(', ')}`, assertions: null, steps: null, sslExpiresAt: null, sslDaysRemaining: null };
  }
  try {
    const res = await http({
      method: c.method || 'GET', url: url.value, headers, body: body?.value,
      timeoutMs: check.timeoutMs, followRedirects: c.followRedirects !== false, maxRedirects: c.maxRedirects, tlsInsecure: c.tlsInsecure === true,
    }, deps.guard);
    const assertions = (c.assertions && c.assertions.length) ? c.assertions : DEFAULT_ASSERTIONS;
    const evald = evaluateAssertions(assertions, view(res));
    const results = evald.results.map((r) => ({ ...r, actual: r.actual === null ? null : redactSecrets(r.actual, deps.secrets) }));
    return {
      status: evald.passed ? 'pass' : 'fail',
      latencyMs: res.latencyMs,
      statusCode: res.status,
      error: evald.passed ? null : `${results.filter((r) => !r.passed).length} assertion(s) failed`,
      assertions: results,
      steps: null,
      sslExpiresAt: tlsExpiry(res.tls),
      sslDaysRemaining: res.tls?.daysRemaining ?? null,
    };
  } catch (err) {
    return { status: 'fail', latencyMs: null, statusCode: null, error: errorText(err, deps.secrets), assertions: null, steps: null, sslExpiresAt: null, sslDaysRemaining: null };
  }
}

/** Multi-step API flow: steps run in order; variables extracted by one step feed the next. */
export async function runMultistep(check: RunnableCheck, deps: RunDeps): Promise<RunOutcome> {
  const c = check.config;
  const http = deps.http || syntheticHttpRequest;
  const now = deps.now || Date.now;
  const started = now();
  const deadline = started + check.timeoutMs;
  const vars: Record<string, string> = { ...(c.variables || {}) };
  const steps: StepOutcome[] = [];
  let failed: string | null = null;
  let lastStatus: number | null = null;
  let sslExpiresAt: Date | null = null;
  let sslDays: number | null = null;

  for (const step of c.steps || []) {
    if (failed) {
      steps.push({ name: step.name, status: 'skipped', latencyMs: null, statusCode: null });
      continue;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      failed = `Timed out before step "${step.name}"`;
      steps.push({ name: step.name, status: 'fail', latencyMs: null, statusCode: null, error: 'flow timeout' });
      continue;
    }
    const unknown: string[] = [];
    const url = renderTemplate(step.url, vars, deps.secrets);
    unknown.push(...url.unknown);
    const headers = renderAll(step.headers || {}, vars, deps.secrets, unknown);
    const body = step.body !== undefined ? renderTemplate(step.body, vars, deps.secrets) : undefined;
    if (body) unknown.push(...body.unknown);
    if (unknown.length) {
      failed = `Step "${step.name}": unknown variables ${[...new Set(unknown)].join(', ')}`;
      steps.push({ name: step.name, status: 'fail', latencyMs: null, statusCode: null, error: failed });
      continue;
    }
    // Rendered values may come from extracted variables: the host must still be the saved one.
    const savedHost = String(step.url).match(/^https?:\/\/([^/?#]*)/i)?.[1]?.toLowerCase();
    const renderedHost = url.value.match(/^https?:\/\/([^/?#]*)/i)?.[1]?.toLowerCase();
    if (!savedHost || savedHost !== renderedHost) {
      failed = `Step "${step.name}": the target host changed after variable substitution`;
      steps.push({ name: step.name, status: 'fail', latencyMs: null, statusCode: null, error: failed });
      continue;
    }
    try {
      const res = await http({
        method: step.method || 'GET', url: url.value, headers, body: body?.value,
        timeoutMs: remaining, followRedirects: true, tlsInsecure: c.tlsInsecure === true,
      }, deps.guard);
      lastStatus = res.status;
      if (res.tls?.validTo && sslExpiresAt === null) { sslExpiresAt = tlsExpiry(res.tls); sslDays = res.tls.daysRemaining; }
      const assertions = (step.assertions && step.assertions.length) ? step.assertions : DEFAULT_ASSERTIONS;
      const evald = evaluateAssertions(assertions, view(res));
      const results = evald.results.map((r) => ({ ...r, actual: r.actual === null ? null : redactSecrets(r.actual, { ...deps.secrets, ...vars }) }));
      const ex = extractVariables(step.extract || [], view(res));
      Object.assign(vars, ex.values);
      const ok = evald.passed && ex.missing.length === 0;
      const outcome: StepOutcome = {
        name: step.name, status: ok ? 'pass' : 'fail', latencyMs: res.latencyMs, statusCode: res.status, assertions: results,
        ...(step.extract?.length ? { extracted: Object.keys(ex.values) } : {}),
      };
      if (!ok) {
        outcome.error = ex.missing.length ? `could not extract: ${ex.missing.join(', ')}` : 'assertion failed';
        failed = `Step "${step.name}": ${outcome.error}`;
      }
      steps.push(outcome);
    } catch (err) {
      failed = `Step "${step.name}": ${errorText(err, deps.secrets)}`;
      steps.push({ name: step.name, status: 'fail', latencyMs: null, statusCode: null, error: errorText(err, deps.secrets) });
    }
  }
  return {
    status: failed ? 'fail' : 'pass',
    latencyMs: now() - started,
    statusCode: lastStatus,
    error: failed ? redactSecrets(failed, { ...deps.secrets }).slice(0, 1000) : null,
    assertions: null,
    steps,
    sslExpiresAt,
    sslDaysRemaining: sslDays,
  };
}

/** SSL expiry: fail when invalid or within criticalDays, degraded (warning) within warnDays. */
export async function runSsl(check: RunnableCheck, deps: RunDeps): Promise<RunOutcome> {
  const c = check.config;
  const probe = deps.tls || syntheticTlsProbe;
  const warnDays = c.warnDays ?? 14;
  const criticalDays = c.criticalDays ?? 0;
  try {
    const info = await probe(c.host, c.port || 443, check.timeoutMs, deps.guard);
    const days = info.daysRemaining;
    const assertions: AssertionResult[] = [
      { source: 'ssl_days', comparison: 'gt', target: criticalDays, actual: days === null ? null : String(days), passed: days !== null && days > criticalDays },
      { source: 'ssl_days', comparison: 'gt', target: warnDays, actual: days === null ? null : String(days), passed: days !== null && days > warnDays },
    ];
    let status: SyntheticResultStatus = 'pass';
    let error: string | null = null;
    if (!info.authorized) {
      status = 'fail';
      error = `Certificate not trusted: ${info.authorizationError || 'unknown error'}`;
    } else if (days === null || days <= criticalDays) {
      status = 'fail';
      error = days !== null && days < 0 ? 'Certificate expired' : `Certificate expires in ${days} day(s)`;
    } else if (days <= warnDays) {
      status = 'degraded';
      error = `Certificate expires in ${days} day(s) (warning at ${warnDays})`;
    }
    return { status, latencyMs: info.latencyMs, statusCode: null, error, assertions, steps: null, sslExpiresAt: info.validTo ? new Date(info.validTo) : null, sslDaysRemaining: days };
  } catch (err) {
    return { status: 'fail', latencyMs: null, statusCode: null, error: errorText(err, deps.secrets), assertions: null, steps: null, sslExpiresAt: null, sslDaysRemaining: null };
  }
}

export async function runCheck(check: RunnableCheck, deps: RunDeps): Promise<RunOutcome> {
  switch (check.type) {
    case 'http': return runHttp(check, deps);
    case 'multistep': return runMultistep(check, deps);
    case 'ssl': return runSsl(check, deps);
    default:
      return { status: 'fail', latencyMs: null, statusCode: null, error: `${check.type} checks do not run in the API`, assertions: null, steps: null, sslExpiresAt: null, sslDaysRemaining: null };
  }
}
