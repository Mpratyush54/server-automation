/**
 * Assertion engine, variable extraction and templating for synthetic checks (#42).
 * Pure functions: no I/O, so they are unit-tested directly and shared by the HTTP,
 * multi-step and browser result paths.
 */

export type AssertionSource = 'status' | 'latency' | 'header' | 'body' | 'json' | 'ssl_days';
export type Comparison =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'not_contains' | 'matches' | 'exists' | 'not_exists';

export interface Assertion {
  source: AssertionSource;
  /** Header name (header) or JSON path like `$.data.items[0].id` (json). */
  property?: string;
  comparison: Comparison;
  target?: string | number | boolean | null;
}

export interface AssertionResult {
  source: AssertionSource;
  property?: string;
  comparison: Comparison;
  target?: string | number | boolean | null;
  /** Observed value (stringified, truncated); never contains the response body beyond 200 chars. */
  actual: string | null;
  passed: boolean;
  message?: string;
}

export interface ResponseView {
  status: number;
  latencyMs: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  sslDaysRemaining?: number | null;
}

export const ASSERTION_SOURCES: AssertionSource[] = ['status', 'latency', 'header', 'body', 'json', 'ssl_days'];
export const COMPARISONS: Comparison[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'not_contains', 'matches', 'exists', 'not_exists'];
export const MAX_REGEX_LENGTH = 200;
/** Regex assertions only see the first 64 KiB of a body (bounded matching time). */
export const REGEX_INPUT_LIMIT = 64 * 1024;

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

/** Reject patterns that are invalid, too long, or have nested quantifiers (catastrophic backtracking). */
export function validateRegex(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return 'pattern is required';
  if (pattern.length > MAX_REGEX_LENGTH) return `pattern is longer than ${MAX_REGEX_LENGTH} characters`;
  if (NESTED_QUANTIFIER.test(pattern)) return 'nested quantifiers are not allowed';
  if (/\\\d/.test(pattern)) return 'back-references are not allowed';
  try {
    new RegExp(pattern);
  } catch {
    return 'invalid regular expression';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON path: `$`, `.key`, `["key"]`, `[0]`. No filters / wildcards.
// ---------------------------------------------------------------------------

export function parseJsonPath(path: string): Array<string | number> | null {
  if (typeof path !== 'string') return null;
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  const out: Array<string | number> = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === '.') {
      const m = p.slice(i + 1).match(/^[A-Za-z0-9_$-]+/);
      if (!m) return null;
      out.push(m[0]);
      i += 1 + m[0].length;
    } else if (p[i] === '[') {
      const rest = p.slice(i);
      const idx = rest.match(/^\[(\d+)\]/);
      const key = rest.match(/^\[(?:"([^"]*)"|'([^']*)')\]/);
      if (idx) { out.push(Number(idx[1])); i += idx[0].length; }
      else if (key) { out.push(key[1] ?? key[2]); i += key[0].length; }
      else return null;
    } else if (i === 0) {
      const m = p.match(/^[A-Za-z0-9_$-]+/);
      if (!m) return null;
      out.push(m[0]);
      i += m[0].length;
    } else {
      return null;
    }
  }
  return out;
}

export function jsonPathGet(doc: unknown, path: string): { found: boolean; value: unknown } {
  const parts = parseJsonPath(path);
  if (!parts) return { found: false, value: undefined };
  let cur: any = doc;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
    if (typeof part === 'number') {
      if (!Array.isArray(cur) || part >= cur.length) return { found: false, value: undefined };
      cur = cur[part];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false, value: undefined };
      cur = cur[part];
    }
  }
  return { found: true, value: cur };
}

function stringify(v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string | null, n = 200): string | null {
  if (s === null) return null;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function compare(actual: unknown, comparison: Comparison, target: unknown, exists: boolean): { passed: boolean; message?: string } {
  switch (comparison) {
    case 'exists': return { passed: exists };
    case 'not_exists': return { passed: !exists };
    default: break;
  }
  if (!exists) return { passed: false, message: 'value not found' };
  const a = actual;
  const numeric = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
  switch (comparison) {
    case 'eq':
    case 'neq': {
      let eq: boolean;
      if (typeof target === 'number' || typeof a === 'number') eq = numeric(a) === numeric(target);
      else if (typeof target === 'boolean' || typeof a === 'boolean') eq = String(a) === String(target);
      else if (target === null) eq = a === null;
      else eq = stringify(a) === String(target);
      return { passed: comparison === 'eq' ? eq : !eq };
    }
    case 'lt': case 'lte': case 'gt': case 'gte': {
      const x = numeric(a);
      const y = numeric(target);
      if (Number.isNaN(x) || Number.isNaN(y)) return { passed: false, message: 'not a number' };
      const passed = comparison === 'lt' ? x < y : comparison === 'lte' ? x <= y : comparison === 'gt' ? x > y : x >= y;
      return { passed };
    }
    case 'contains':
    case 'not_contains': {
      const has = (stringify(a) || '').includes(String(target ?? ''));
      return { passed: comparison === 'contains' ? has : !has };
    }
    case 'matches': {
      const err = validateRegex(String(target ?? ''));
      if (err) return { passed: false, message: err };
      const input = (stringify(a) || '').slice(0, REGEX_INPUT_LIMIT);
      return { passed: new RegExp(String(target)).test(input) };
    }
    default:
      return { passed: false, message: `unknown comparison ${comparison}` };
  }
}

/** Evaluate one assertion against a response. Never throws. */
export function evaluateAssertion(assertion: Assertion, res: ResponseView): AssertionResult {
  const base: AssertionResult = {
    source: assertion.source,
    ...(assertion.property !== undefined ? { property: assertion.property } : {}),
    comparison: assertion.comparison,
    ...(assertion.target !== undefined ? { target: assertion.target } : {}),
    actual: null,
    passed: false,
  };
  try {
    let actual: unknown;
    let exists = true;
    switch (assertion.source) {
      case 'status': actual = res.status; break;
      case 'latency': actual = res.latencyMs; break;
      case 'ssl_days':
        actual = res.sslDaysRemaining;
        exists = typeof res.sslDaysRemaining === 'number';
        break;
      case 'header': {
        const name = String(assertion.property || '').toLowerCase();
        exists = Object.prototype.hasOwnProperty.call(res.headers, name);
        actual = exists ? res.headers[name] : undefined;
        break;
      }
      case 'body': actual = res.body; break;
      case 'json': {
        let doc: unknown;
        try {
          doc = JSON.parse(res.body);
        } catch {
          return { ...base, message: 'response body is not JSON' };
        }
        const got = jsonPathGet(doc, String(assertion.property || '$'));
        exists = got.found;
        actual = got.value;
        break;
      }
      default:
        return { ...base, message: `unknown source ${assertion.source}` };
    }
    const outcome = compare(actual, assertion.comparison, assertion.target, exists);
    // Body values are user data from the target: keep only a short excerpt.
    const shown = assertion.source === 'body' ? null : truncate(stringify(actual));
    return { ...base, actual: shown, passed: outcome.passed, ...(outcome.message ? { message: outcome.message } : {}) };
  } catch (err: any) {
    return { ...base, message: err?.message || 'assertion failed' };
  }
}

export function evaluateAssertions(assertions: Assertion[], res: ResponseView): { passed: boolean; results: AssertionResult[] } {
  const results = assertions.map((a) => evaluateAssertion(a, res));
  return { passed: results.every((r) => r.passed), results };
}

/** Default when a check defines no assertions: any 2xx/3xx status. */
export const DEFAULT_ASSERTIONS: Assertion[] = [{ source: 'status', comparison: 'lt', target: 400 }];

// ---------------------------------------------------------------------------
// Variables: extraction + {{templates}}
// ---------------------------------------------------------------------------

export interface Extraction {
  /** Variable name: letters, digits, underscore. */
  name: string;
  source: 'json' | 'header' | 'body_regex' | 'status';
  /** JSON path, header name, or regex with one capture group. */
  property?: string;
}

export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_VAR_LENGTH = 4096;

/** Extract variables from a response; missing values are reported, not thrown. */
export function extractVariables(extractions: Extraction[], res: ResponseView): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  let doc: unknown;
  let parsed = false;
  for (const ex of extractions) {
    let v: string | null = null;
    if (ex.source === 'status') v = String(res.status);
    else if (ex.source === 'header') {
      const name = String(ex.property || '').toLowerCase();
      v = Object.prototype.hasOwnProperty.call(res.headers, name) ? res.headers[name] : null;
    } else if (ex.source === 'json') {
      if (!parsed) {
        parsed = true;
        try { doc = JSON.parse(res.body); } catch { doc = undefined; }
      }
      const got = jsonPathGet(doc, String(ex.property || '$'));
      v = got.found ? stringify(got.value) : null;
    } else if (ex.source === 'body_regex') {
      const pattern = String(ex.property || '');
      if (!validateRegex(pattern)) {
        const m = res.body.slice(0, REGEX_INPUT_LIMIT).match(new RegExp(pattern));
        v = m ? (m[1] ?? m[0]) : null;
      }
    }
    if (v === null || v === undefined) missing.push(ex.name);
    else values[ex.name] = v.slice(0, MAX_VAR_LENGTH);
  }
  return { values, missing };
}

const TEMPLATE_RE = /\{\{\s*(secret\.)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;

/**
 * Replace `{{name}}` with a variable and `{{secret.NAME}}` with a check secret.
 * Unknown names are left untouched and reported.
 */
export function renderTemplate(
  input: string,
  vars: Record<string, string>,
  secrets: Record<string, string> = {},
): { value: string; unknown: string[] } {
  const unknown: string[] = [];
  const value = String(input).replace(TEMPLATE_RE, (whole, secretPrefix: string | undefined, name: string) => {
    const pool = secretPrefix ? secrets : vars;
    if (Object.prototype.hasOwnProperty.call(pool, name)) return pool[name];
    unknown.push(secretPrefix ? `secret.${name}` : name);
    return whole;
  });
  return { value, unknown };
}

/** Names referenced as `{{secret.NAME}}` in any of the strings. */
export function referencedSecrets(...inputs: string[]): string[] {
  const out = new Set<string>();
  for (const s of inputs) {
    for (const m of String(s || '').matchAll(TEMPLATE_RE)) if (m[1]) out.add(m[2]);
  }
  return [...out];
}

/** Replace any occurrence of a secret value (length >= 4) in text that will be stored. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = String(text);
  for (const value of Object.values(secrets)) {
    if (typeof value === 'string' && value.length >= 4) out = out.split(value).join('[redacted]');
  }
  return out;
}
