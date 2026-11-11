import crypto from 'crypto';
import {
  Assertion, ASSERTION_SOURCES, COMPARISONS, Extraction, VAR_NAME_RE, validateRegex,
} from './synthetic-assertions';
import { decryptValue, encryptValue } from './secrets-encryption';
import { validateUrlSyntax, SsrfError } from './synthetic-ssrf';
import { browserNextRun } from './synthetic-cron';
import type { SyntheticAlertPolicy, SyntheticCheck, SyntheticCheckType } from '../entities/SyntheticCheck';

/**
 * Synthetic check definitions (#42): validation/normalisation of API input, defaults,
 * limits, encrypted check secrets, and the public (secret-free) view.
 */

export const CHECK_TYPES: SyntheticCheckType[] = ['http', 'multistep', 'browser', 'ssl'];
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export const BROWSER_ACTIONS = ['goto', 'click', 'fill', 'press', 'wait_for', 'assert_text', 'assert_title', 'assert_url', 'wait'] as const;
export type BrowserAction = typeof BROWSER_ACTIONS[number];

/** Minimum interval per type (seconds). Browser checks are heavy: 5 minutes minimum. */
export const MIN_INTERVAL: Record<SyntheticCheckType, number> = { http: 60, multistep: 60, ssl: 300, browser: 300 };
export const MAX_INTERVAL = 86_400;
/** Browser intervals must map to a cron schedule: minutes dividing 60, or whole hours dividing 24. */
export const BROWSER_INTERVALS = [300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
export const MAX_TIMEOUT_MS: Record<SyntheticCheckType, number> = { http: 30_000, ssl: 30_000, multistep: 60_000, browser: 120_000 };
export const MAX_STEPS = 10;
export const MAX_BROWSER_STEPS = 25;
export const MAX_ASSERTIONS = 20;
export const MAX_HEADERS = 20;
export const MAX_BODY_LENGTH = 64 * 1024;
export const MAX_SECRETS = 20;
export const MAX_SECRET_LENGTH = 4096;
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Headers a check may never set (hop-by-hop / routing / platform identity). */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'x-platform-project-id', 'x-platform-environment', 'x-forwarded-for', 'x-real-ip']);

export function maxChecksPerProject(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SYNTHETICS_MAX_CHECKS_PER_PROJECT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

export const DEFAULT_ALERT_POLICY: SyntheticAlertPolicy = { enabled: true, failureThreshold: 2, severity: 'critical' };

export function normaliseAlertPolicy(raw: any): SyntheticAlertPolicy {
  const p = raw && typeof raw === 'object' ? raw : {};
  const threshold = Number(p.failureThreshold);
  return {
    enabled: p.enabled === undefined ? true : p.enabled === true,
    failureThreshold: Number.isInteger(threshold) && threshold >= 1 && threshold <= 10 ? threshold : DEFAULT_ALERT_POLICY.failureThreshold,
    severity: p.severity === 'warning' ? 'warning' : 'critical',
  };
}

export class CheckValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CheckValidationError';
  }
}

function fail(msg: string): never {
  throw new CheckValidationError(msg);
}

function str(v: unknown, field: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') fail(`${field} must be a string`);
  if (v.length > max) fail(`${field} must be at most ${max} characters`);
  return v;
}

function validateTemplatedUrl(raw: unknown, field: string, ingressHosts: string[]): string {
  const url = str(raw, field, 2048);
  if (url.includes('{{')) {
    // Host part must not be templated: the target host is validated at save time.
    const m = url.match(/^(https?):\/\/([^/?#]*)/i);
    if (!m) fail(`${field} must start with http:// or https://`);
    if (m[2].includes('{{')) fail(`${field}: the host cannot contain variables`);
    try {
      validateUrlSyntax(`${m[1]}://${m[2]}/`, { allowedIngressHosts: ingressHosts });
    } catch (err: any) {
      fail(`${field}: ${err.message}`);
    }
    return url;
  }
  try {
    validateUrlSyntax(url, { allowedIngressHosts: ingressHosts });
  } catch (err: any) {
    if (err instanceof SsrfError) fail(`${field}: ${err.message}`);
    throw err;
  }
  return url;
}

function headersOf(raw: unknown, field: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${field} must be an object`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) fail(`${field}: at most ${MAX_HEADERS} headers`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!HEADER_NAME_RE.test(k)) fail(`${field}: invalid header name ${JSON.stringify(k)}`);
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) fail(`${field}: header ${k} cannot be set`);
    if (typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v)) fail(`${field}.${k} must be a single-line string`);
    out[k] = v;
  }
  return out;
}

export function validateAssertions(raw: unknown, field: string): Assertion[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${field} must be an array`);
  if (raw.length > MAX_ASSERTIONS) fail(`${field}: at most ${MAX_ASSERTIONS} assertions`);
  return raw.map((a: any, i: number) => {
    const f = `${field}[${i}]`;
    if (!a || typeof a !== 'object') fail(`${f} must be an object`);
    if (!ASSERTION_SOURCES.includes(a.source)) fail(`${f}.source must be one of ${ASSERTION_SOURCES.join(', ')}`);
    if (!COMPARISONS.includes(a.comparison)) fail(`${f}.comparison must be one of ${COMPARISONS.join(', ')}`);
    if ((a.source === 'header' || a.source === 'json') && (typeof a.property !== 'string' || !a.property)) fail(`${f}.property is required for ${a.source}`);
    if (a.property !== undefined && (typeof a.property !== 'string' || a.property.length > 200)) fail(`${f}.property must be a string`);
    const needsTarget = a.comparison !== 'exists' && a.comparison !== 'not_exists';
    if (needsTarget && (a.target === undefined || (typeof a.target === 'object' && a.target !== null))) fail(`${f}.target is required`);
    if (typeof a.target === 'string' && a.target.length > 1000) fail(`${f}.target is too long`);
    if (a.comparison === 'matches') {
      const err = validateRegex(String(a.target));
      if (err) fail(`${f}.target: ${err}`);
    }
    const out: Assertion = { source: a.source, comparison: a.comparison };
    if (a.property !== undefined) out.property = a.property;
    if (needsTarget) out.target = a.target;
    return out;
  });
}

function validateExtractions(raw: unknown, field: string): Extraction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) fail(`${field} must be an array of at most 20 items`);
  return raw.map((e: any, i: number) => {
    const f = `${field}[${i}]`;
    if (!e || typeof e.name !== 'string' || !VAR_NAME_RE.test(e.name)) fail(`${f}.name must be a variable name`);
    if (!['json', 'header', 'body_regex', 'status'].includes(e.source)) fail(`${f}.source must be json, header, body_regex or status`);
    if (e.source !== 'status' && (typeof e.property !== 'string' || !e.property || e.property.length > 200)) fail(`${f}.property is required`);
    if (e.source === 'body_regex') {
      const err = validateRegex(e.property);
      if (err) fail(`${f}.property: ${err}`);
    }
    return { name: e.name, source: e.source, ...(e.property !== undefined ? { property: e.property } : {}) };
  });
}

function method(raw: unknown, field: string): string {
  const m = String(raw || 'GET').toUpperCase();
  if (!HTTP_METHODS.includes(m)) fail(`${field} must be one of ${HTTP_METHODS.join(', ')}`);
  return m;
}

function bodyOf(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') fail(`${field} must be a string`);
  if (raw.length > MAX_BODY_LENGTH) fail(`${field} is too long`);
  return raw;
}

function statusPageOf(raw: any): { visible: boolean; name?: string } {
  if (!raw || typeof raw !== 'object') return { visible: true };
  const out: { visible: boolean; name?: string } = { visible: raw.visible !== false };
  if (raw.name !== undefined && raw.name !== null && raw.name !== '') out.name = str(raw.name, 'statusPage.name', 100);
  return out;
}

/** Validate the type-specific `config`; returns the normalised config to store. */
export function validateConfig(type: SyntheticCheckType, raw: any, ingressHosts: string[]): Record<string, any> {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : fail('config must be an object');
  const statusPage = statusPageOf(c.statusPage);
  switch (type) {
    case 'http': {
      const maxRedirects = c.maxRedirects === undefined ? 5 : Number(c.maxRedirects);
      if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) fail('config.maxRedirects must be 0..5');
      return {
        url: validateTemplatedUrl(c.url, 'config.url', ingressHosts),
        method: method(c.method, 'config.method'),
        headers: headersOf(c.headers, 'config.headers'),
        ...(bodyOf(c.body, 'config.body') !== undefined ? { body: c.body } : {}),
        assertions: validateAssertions(c.assertions, 'config.assertions'),
        followRedirects: c.followRedirects !== false,
        maxRedirects,
        tlsInsecure: c.tlsInsecure === true,
        statusPage,
      };
    }
    case 'multistep': {
      if (!Array.isArray(c.steps) || c.steps.length === 0) fail('config.steps must be a non-empty array');
      if (c.steps.length > MAX_STEPS) fail(`config.steps: at most ${MAX_STEPS} steps`);
      const variables: Record<string, string> = {};
      if (c.variables !== undefined) {
        if (!c.variables || typeof c.variables !== 'object' || Array.isArray(c.variables)) fail('config.variables must be an object');
        for (const [k, v] of Object.entries(c.variables)) {
          if (!VAR_NAME_RE.test(k)) fail(`config.variables: invalid name ${JSON.stringify(k)}`);
          if (typeof v !== 'string' || v.length > 1000) fail(`config.variables.${k} must be a string`);
          variables[k] = v;
        }
      }
      const steps = c.steps.map((s: any, i: number) => {
        const f = `config.steps[${i}]`;
        if (!s || typeof s !== 'object') fail(`${f} must be an object`);
        return {
          name: str(s.name || `Step ${i + 1}`, `${f}.name`, 100),
          method: method(s.method, `${f}.method`),
          url: validateTemplatedUrl(s.url, `${f}.url`, ingressHosts),
          headers: headersOf(s.headers, `${f}.headers`),
          ...(bodyOf(s.body, `${f}.body`) !== undefined ? { body: s.body } : {}),
          assertions: validateAssertions(s.assertions, `${f}.assertions`),
          extract: validateExtractions(s.extract, `${f}.extract`),
        };
      });
      return { steps, variables, tlsInsecure: c.tlsInsecure === true, statusPage };
    }
    case 'ssl': {
      const host = str(c.host, 'config.host', 253).toLowerCase();
      const port = c.port === undefined ? 443 : Number(c.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('config.port must be 1..65535');
      try {
        validateUrlSyntax(`https://${host.includes(':') ? `[${host}]` : host}:${port}/`, { allowedIngressHosts: ingressHosts });
      } catch (err: any) {
        fail(`config.host: ${err.message}`);
      }
      const warnDays = c.warnDays === undefined ? 14 : Number(c.warnDays);
      const criticalDays = c.criticalDays === undefined ? 0 : Number(c.criticalDays);
      if (!Number.isInteger(warnDays) || warnDays < 1 || warnDays > 365) fail('config.warnDays must be 1..365');
      if (!Number.isInteger(criticalDays) || criticalDays < 0 || criticalDays >= warnDays) fail('config.criticalDays must be 0..warnDays-1');
      return { host, port, warnDays, criticalDays, statusPage };
    }
    case 'browser': {
      if (!Array.isArray(c.steps) || c.steps.length === 0) fail('config.steps must be a non-empty array');
      if (c.steps.length > MAX_BROWSER_STEPS) fail(`config.steps: at most ${MAX_BROWSER_STEPS} steps`);
      const steps = c.steps.map((s: any, i: number) => {
        const f = `config.steps[${i}]`;
        if (!s || !BROWSER_ACTIONS.includes(s.action)) fail(`${f}.action must be one of ${BROWSER_ACTIONS.join(', ')}`);
        const step: Record<string, any> = { action: s.action };
        if (s.action === 'goto') step.url = validateTemplatedUrl(s.url, `${f}.url`, ingressHosts);
        if (['click', 'fill', 'press', 'wait_for', 'assert_text'].includes(s.action)) step.selector = str(s.selector, `${f}.selector`, 500);
        if (['fill', 'press', 'assert_text', 'assert_title', 'assert_url'].includes(s.action)) step.value = str(s.value, `${f}.value`, 2000);
        if (s.action === 'wait') {
          const ms = Number(s.ms);
          if (!Number.isInteger(ms) || ms < 0 || ms > 30_000) fail(`${f}.ms must be 0..30000`);
          step.ms = ms;
        }
        return step;
      });
      if (steps[0].action !== 'goto') fail('config.steps[0] must be a goto step');
      return { steps, statusPage };
    }
    default:
      return fail('unknown check type');
  }
}

export interface CheckInput {
  name: string;
  type: SyntheticCheckType;
  environmentId: string | null;
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  config: Record<string, any>;
  alertPolicy: SyntheticAlertPolicy;
  locations: string[];
  /** Secret changes: value sets, null deletes. Undefined = unchanged. */
  secrets?: Record<string, string | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a create (existing = undefined) or full update body. */
export function validateCheckInput(body: any, ingressHosts: string[], existing?: Pick<SyntheticCheck, 'type'>): CheckInput {
  const b = body && typeof body === 'object' ? body : fail('body must be an object');
  const type: SyntheticCheckType = existing ? existing.type : b.type;
  if (!CHECK_TYPES.includes(type)) fail(`type must be one of ${CHECK_TYPES.join(', ')}`);
  if (existing && b.type !== undefined && b.type !== existing.type) fail('type cannot be changed');
  const name = str(b.name, 'name', 100).trim();
  if (!name) fail('name is required');
  const intervalSeconds = b.intervalSeconds === undefined ? Math.max(300, MIN_INTERVAL[type]) : Number(b.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL[type] || intervalSeconds > MAX_INTERVAL) {
    fail(`intervalSeconds must be ${MIN_INTERVAL[type]}..${MAX_INTERVAL} for ${type} checks`);
  }
  if (type === 'browser' && !BROWSER_INTERVALS.includes(intervalSeconds)) {
    fail(`intervalSeconds for browser checks must be one of ${BROWSER_INTERVALS.join(', ')}`);
  }
  const timeoutMs = b.timeoutMs === undefined ? Math.min(10_000, MAX_TIMEOUT_MS[type]) : Number(b.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS[type]) fail(`timeoutMs must be 1000..${MAX_TIMEOUT_MS[type]}`);
  let environmentId: string | null = null;
  if (b.environmentId !== undefined && b.environmentId !== null && b.environmentId !== '') {
    if (typeof b.environmentId !== 'string' || !UUID_RE.test(b.environmentId)) fail('environmentId must be a UUID');
    environmentId = b.environmentId;
  }
  const locations = b.locations === undefined ? ['local'] : b.locations;
  if (!Array.isArray(locations) || locations.length !== 1 || locations[0] !== 'local') {
    fail('locations: only ["local"] (this cluster) is supported');
  }
  let secrets: Record<string, string | null> | undefined;
  if (b.secrets !== undefined) {
    if (!b.secrets || typeof b.secrets !== 'object' || Array.isArray(b.secrets)) fail('secrets must be an object');
    secrets = {};
    for (const [k, v] of Object.entries(b.secrets)) {
      if (!SECRET_NAME_RE.test(k)) fail(`secrets: invalid name ${JSON.stringify(k)}`);
      if (v !== null && (typeof v !== 'string' || v.length === 0 || v.length > MAX_SECRET_LENGTH || /[\r\n]/.test(v))) {
        fail(`secrets.${k} must be a non-empty single-line string or null`);
      }
      secrets[k] = v as string | null;
    }
  }
  return {
    name,
    type,
    environmentId,
    enabled: b.enabled !== false,
    intervalSeconds,
    timeoutMs,
    config: validateConfig(type, b.config, ingressHosts),
    alertPolicy: normaliseAlertPolicy(b.alertPolicy),
    locations: ['local'],
    ...(secrets ? { secrets } : {}),
  };
}

// ---------------------------------------------------------------------------
// Secrets (encrypted at rest, never returned)
// ---------------------------------------------------------------------------

function masterKey(): string {
  const k = process.env.SECRETS_ENCRYPTION_KEY;
  if (!k) throw new Error('SECRETS_ENCRYPTION_KEY not configured');
  return k;
}

export function decryptCheckSecrets(encrypted: string | null | undefined): Record<string, string> {
  if (!encrypted) return {};
  const parsed = JSON.parse(decryptValue(encrypted, masterKey()));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function encryptCheckSecrets(secrets: Record<string, string>): string | null {
  return Object.keys(secrets).length === 0 ? null : encryptValue(JSON.stringify(secrets), masterKey());
}

/** Apply set/delete changes to the stored secrets; returns the new encrypted blob. */
export function mergeCheckSecrets(encrypted: string | null, changes: Record<string, string | null> | undefined): string | null {
  if (!changes) return encrypted;
  const current = decryptCheckSecrets(encrypted);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete current[k];
    else current[k] = v;
  }
  if (Object.keys(current).length > MAX_SECRETS) fail(`at most ${MAX_SECRETS} secrets per check`);
  return encryptCheckSecrets(current);
}

export function secretNames(encrypted: string | null): string[] {
  try {
    return Object.keys(decryptCheckSecrets(encrypted)).sort();
  } catch {
    return [];
  }
}

/**
 * API view of a check: no encrypted blob, only secret names. Browser checks run from
 * their CronJob, so their nextRunAt is the CronJob's next scheduled time (UTC), not the
 * in-API scheduler's (unused) next_run_at.
 */
export function publicCheck(check: SyntheticCheck, now = new Date()): Record<string, any> {
  const { secretsEncrypted, ...rest } = check;
  const nextRunAt = check.type === 'browser' ? browserNextRun(check, now) : check.nextRunAt;
  return {
    ...rest,
    nextRunAt,
    alertPolicy: normaliseAlertPolicy(check.alertPolicy),
    locations: check.locations?.length ? check.locations : ['local'],
    secretNames: secretNames(secretsEncrypted),
  };
}

// ---------------------------------------------------------------------------
// Browser runner tokens: HMAC(checkId) with a key derived from SECRETS_ENCRYPTION_KEY.
// ---------------------------------------------------------------------------

export function runnerToken(checkId: string, key: string = masterKey()): string {
  const derived = crypto.createHmac('sha256', key).update('synthetics-runner-v1').digest();
  return `synr_${crypto.createHmac('sha256', derived).update(checkId).digest('base64url')}`;
}

export function verifyRunnerToken(checkId: string, token: string, key?: string): boolean {
  let expected: string;
  try {
    expected = runnerToken(checkId, key);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Ingress hosts that belong to the project: the hosts of its active environments. These
 * (and only these) may resolve to a private address (see synthetic-ssrf). The platform's
 * own DOMAIN is never treated as a project host.
 */
export function projectIngressHosts(environments: Array<{ domain?: string | null; isActive?: boolean }>, platformDomain = process.env.DOMAIN || ''): string[] {
  const hosts = new Set<string>();
  const platform = String(platformDomain).trim().toLowerCase();
  for (const e of environments) {
    if (e.isActive === false || !e.domain) continue;
    const h = String(e.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    if (h && h !== platform) hosts.add(h);
  }
  return [...hosts];
}
