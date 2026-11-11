/**
 * Project scoping for the observability query proxies (#48).
 *
 * Every query that reaches Prometheus, Loki, Tempo or Pyroscope on behalf of a
 * user is rewritten here so that it can only read the caller's project. The
 * rewriters never concatenate user text into a query: they lex it (strings,
 * comments and operators are understood the same way the backend lexers
 * understand them), rebuild it token by token and inject the project matcher
 * into every place that selects data:
 *
 * - PromQL: every vector selector (`metric`, `metric{...}`, `{...}`) gets
 *   `platform_project_id="<id>"` (prom-label-proxy style). User matchers on that
 *   label are refused unless they are exactly the caller's own id. Binary
 *   operators (`or`, `unless`, `and`), subqueries and functions are fine because
 *   every operand selector is scoped.
 * - LogQL: every stream selector `{...}` gets the matcher (stream mode), or the
 *   label filter `| platform_project_id="<id>"` right after it (metadata mode,
 *   for installs where the id is structured metadata).
 * - TraceQL: every spanset filter `{ cond }` becomes
 *   `{ resource.platform.project_id = "<id>" && (cond) }`; parentheses must
 *   balance inside each filter so the condition cannot escape the wrapper.
 * - Pyroscope: no user selectors at all; selectors are built from validated
 *   parameters.
 *
 * Anything the lexers do not understand (unknown characters, char literals,
 * block comments, unsupported selector syntax such as `or` inside braces) is
 * refused with a QueryScopeError (HTTP 400) instead of being passed through.
 * After rewriting, the result is scanned again and must need no further
 * injection (fail closed).
 */

export const PROJECT_LABEL = 'platform_project_id';
export const TRACE_PROJECT_ATTRIBUTE = 'resource.platform.project_id';
export const MAX_QUERY_LENGTH = 4000;
const MAX_SELECTORS = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QueryScopeError extends Error {
  readonly status = 400;
}

function fail(msg: string): never {
  throw new QueryScopeError(msg);
}

export function assertProjectId(projectId: string): string {
  if (!UUID_RE.test(String(projectId))) fail('invalid project id');
  return String(projectId).toLowerCase();
}

/** A Go/PromQL/LogQL/TraceQL double-quoted string literal (JSON escaping is a subset Go accepts). */
export function quote(value: string): string {
  return JSON.stringify(String(value));
}

/** Escape a value for use inside a regex matcher (RE2), before quoting. */
export function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkInput(query: unknown): string {
  if (typeof query !== 'string' || !query.trim()) fail('query is required');
  if (query.length > MAX_QUERY_LENGTH) fail(`query is too long (max ${MAX_QUERY_LENGTH} characters)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) fail('query contains control characters');
  return query;
}

// ---------------------------------------------------------------------------
// Lexer shared by PromQL and LogQL
// ---------------------------------------------------------------------------

type Lang = 'promql' | 'logql';
type TokKind = 'ident' | 'number' | 'string' | 'punct';

interface Tok {
  kind: TokKind;
  text: string;
  /** Whitespace or a comment preceded this token in the source. */
  gap: boolean;
}

const PUNCT2 = ['=~', '!~', '!=', '==', '>=', '<=', '|=', '|~', '|>', '!>'];
const PUNCT1 = new Set(['{', '}', '(', ')', '[', ']', ',', '=', '<', '>', '+', '-', '*', '/', '%', '^', '@', ':', '|']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function lex(src: string, lang: Lang): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let gap = false;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { gap = true; i++; continue; }
    if (c === '#') {
      // Line comment (PromQL and LogQL). Dropped from the rebuilt query.
      while (i < n && src[i] !== '\n') i++;
      gap = true;
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) fail('comments of this form are not supported');
    if (c === '"' || c === '`' || (c === "'" && lang === 'promql')) {
      const start = i;
      i++;
      if (c === '`') {
        while (i < n && src[i] !== '`') i++;
        if (i >= n) fail('unterminated string');
        i++;
      } else {
        let closed = false;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { if (i + 1 >= n || src[i + 1] === '\n') fail('invalid escape in string'); i += 2; continue; }
          if (d === '\n') fail('unterminated string');
          if (d === c) { closed = true; i++; break; }
          i++;
        }
        if (!closed) fail('unterminated string');
      }
      out.push({ kind: 'string', text: src.slice(start, i), gap });
      gap = false;
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_:]/.test(src[i])) i++;
      out.push({ kind: 'ident', text: src.slice(start, i), gap });
      gap = false;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i;
      i++;
      while (i < n) {
        const d = src[i];
        if (/[0-9A-Za-z_.]/.test(d)) { i++; continue; }
        // Exponent sign: 1e+5 / 2E-3 (not hex).
        if ((d === '+' || d === '-') && /[eE]/.test(src[i - 1]) && !/^0[xX]/.test(src.slice(start, i)) && /[0-9]/.test(src[i + 1] || '')) { i++; continue; }
        break;
      }
      out.push({ kind: 'number', text: src.slice(start, i), gap });
      gap = false;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      out.push({ kind: 'punct', text: two, gap });
      gap = false;
      i += 2;
      continue;
    }
    if (PUNCT1.has(c)) {
      out.push({ kind: 'punct', text: c, gap });
      gap = false;
      i++;
      continue;
    }
    fail(`unsupported character ${JSON.stringify(c)} in query`);
  }
  return out;
}

function render(tokens: Tok[]): string {
  let s = '';
  for (const t of tokens) s += (t.gap && s ? ' ' : '') + t.text;
  return s;
}

const MATCH_OPS = new Set(['=', '!=', '=~', '!~']);

interface SelectorParse {
  /** Index of the closing brace. */
  end: number;
  /** Rebuilt matchers (without the project matcher). */
  matchers: string[];
  /** The selector already contained `platform_project_id="<id>"`. */
  hadOwn: boolean;
}

/** Parse `{ ... }` starting at tokens[open] (which is `{`). Strict grammar; refuses anything else. */
function parseSelector(tokens: Tok[], open: number, lang: Lang, projectId: string): SelectorParse {
  const matchers: string[] = [];
  let hadOwn = false;
  let i = open + 1;
  for (;;) {
    const t = tokens[i];
    if (!t) fail('unterminated selector');
    if (t.kind === 'punct' && t.text === '}') return { end: i, matchers, hadOwn };
    let name: string;
    if (t.kind === 'ident') name = t.text;
    else if (t.kind === 'string' && lang === 'promql') {
      if (t.text.includes('\\')) fail('escape sequences are not allowed in quoted label names');
      name = t.text.slice(1, -1);
    } else fail('unsupported selector syntax (expected a label name)');
    const op = tokens[i + 1];
    if (lang === 'promql' && t.kind === 'string' && op && op.kind === 'punct' && (op.text === ',' || op.text === '}')) {
      // Prometheus 3 quoted metric name: {"metric.name", ...}
      matchers.push(t.text);
      i += op.text === ',' ? 2 : 1;
      continue;
    }
    if (!op || op.kind !== 'punct' || !MATCH_OPS.has(op.text)) fail('unsupported selector syntax (expected =, !=, =~ or !~)');
    const val = tokens[i + 2];
    if (!val || val.kind !== 'string') fail('unsupported selector syntax (expected a quoted value)');
    if (name === PROJECT_LABEL) {
      const own = op.text === '=' && !val.text.includes('\\') && val.text.slice(1, -1) === projectId;
      if (!own) fail(`matchers on ${PROJECT_LABEL} are set by the server and cannot be changed`);
      hadOwn = true;
    } else {
      matchers.push(`${t.text}${op.text}${val.text}`);
    }
    const sep = tokens[i + 3];
    if (!sep) fail('unterminated selector');
    if (sep.kind === 'punct' && sep.text === ',') { i += 4; continue; }
    if (sep.kind === 'punct' && sep.text === '}') { i += 3; continue; }
    fail('unsupported selector syntax (expected , or })');
  }
}

function scopedSelector(matchers: string[], projectId: string): Tok {
  return { kind: 'punct', text: `{${[...matchers, `${PROJECT_LABEL}=${quote(projectId)}`].join(',')}}`, gap: false };
}

// ---------------------------------------------------------------------------
// PromQL
// ---------------------------------------------------------------------------

const PROM_BINARY_KEYWORDS = new Set(['and', 'or', 'unless', 'atan2']);
const PROM_LABEL_LIST_KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);
const PROM_AGGREGATORS = new Set(['sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values', 'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio']);
const PROM_COMPARISON = new Set(['==', '!=', '>', '<', '>=', '<=']);

interface PromRewrite {
  query: string;
  /** Selectors that needed the project matcher added. */
  injected: number;
}

function rewritePromTokens(tokens: Tok[], projectId: string): PromRewrite {
  const out: Tok[] = [];
  let injected = 0;
  let selectors = 0;
  let exprEnd = false; // previous token ends an expression operand
  let lastListKeyword: string | null = null; // keyword of the label list that just closed
  const next = (i: number) => tokens[i + 1];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const closedList = lastListKeyword;
    lastListKeyword = null;
    if (t.kind === 'string' || t.kind === 'number') { out.push(t); exprEnd = true; continue; }
    if (t.kind === 'punct') {
      if (t.text === '{') {
        const sel = parseSelector(tokens, i, 'promql', projectId);
        if (++selectors > MAX_SELECTORS) fail('too many selectors in query');
        if (!sel.hadOwn) injected++;
        out.push({ ...scopedSelector(sel.matchers, projectId), gap: t.gap });
        i = sel.end;
        exprEnd = true;
        continue;
      }
      if (t.text === '}') fail('unbalanced }');
      if (t.text === '[') {
        // Range / subquery durations only.
        out.push(t);
        let j = i + 1;
        for (; j < tokens.length; j++) {
          const u = tokens[j];
          out.push(u);
          if (u.kind === 'punct' && u.text === ']') break;
          if (!(u.kind === 'number' || (u.kind === 'punct' && u.text === ':'))) fail('only durations are allowed inside [ ]');
        }
        if (j >= tokens.length) fail('unbalanced [');
        i = j;
        exprEnd = true;
        continue;
      }
      out.push(t);
      exprEnd = t.text === ')' || t.text === ']';
      continue;
    }
    // Identifier.
    const word = t.text;
    const lower = word.toLowerCase();
    const nx = next(i);
    const nextIsParen = !!nx && nx.kind === 'punct' && nx.text === '(';
    if (PROM_LABEL_LIST_KEYWORDS.has(lower) && nextIsParen) {
      // Grouping label list: idents / quoted names / commas only.
      out.push(t, nx);
      let j = i + 2;
      for (; j < tokens.length; j++) {
        const u = tokens[j];
        out.push(u);
        if (u.kind === 'punct' && u.text === ')') break;
        if (!(u.kind === 'ident' || u.kind === 'string' || (u.kind === 'punct' && u.text === ','))) fail(`only label names are allowed in ${lower}( )`);
      }
      if (j >= tokens.length) fail('unbalanced (');
      i = j;
      lastListKeyword = lower;
      // Postfix `sum(x) by (y)` ends an operand; after `on (x)` / `group_left (y)` an operand follows.
      exprEnd = lower === 'by' || lower === 'without';
      continue;
    }
    if (nextIsParen) { out.push(t); exprEnd = false; continue; } // function / aggregation call
    // `Inf` / `NaN` are deliberately not special-cased: if a backend lexes them as
    // identifiers they are metric names, so they get a matcher too (fail closed).
    if (PROM_AGGREGATORS.has(lower) && nx && nx.kind === 'ident' && (nx.text.toLowerCase() === 'by' || nx.text.toLowerCase() === 'without')) {
      out.push(t);
      exprEnd = false;
      continue;
    }
    if (PROM_BINARY_KEYWORDS.has(lower) && exprEnd) { out.push(t); exprEnd = false; continue; }
    const prev = out[out.length - 1];
    if (lower === 'bool' && prev && prev.kind === 'punct' && PROM_COMPARISON.has(prev.text)) { out.push(t); exprEnd = false; continue; }
    if (lower === 'offset' && exprEnd && nx && (nx.kind === 'number' || (nx.kind === 'punct' && (nx.text === '-' || nx.text === '+')))) {
      out.push(t);
      exprEnd = false;
      continue;
    }
    if ((lower === 'group_left' || lower === 'group_right') && (closedList === 'on' || closedList === 'ignoring')) {
      out.push(t);
      exprEnd = false;
      continue;
    }
    // Anything else is a metric name: a vector selector.
    if (++selectors > MAX_SELECTORS) fail('too many selectors in query');
    if (nx && nx.kind === 'punct' && nx.text === '{') {
      const sel = parseSelector(tokens, i + 1, 'promql', projectId);
      if (!sel.hadOwn) injected++;
      out.push(t, scopedSelector(sel.matchers, projectId));
      i = sel.end;
    } else {
      injected++;
      out.push(t, scopedSelector([], projectId));
    }
    exprEnd = true;
  }
  return { query: render(out), injected };
}

/**
 * Scope a PromQL expression to one project. Throws QueryScopeError when the
 * expression cannot be scoped safely.
 */
export function scopePromQL(query: unknown, projectIdRaw: string): string {
  const projectId = assertProjectId(projectIdRaw);
  const src = checkInput(query);
  const first = rewritePromTokens(lex(src, 'promql'), projectId);
  // Fail closed: the rewritten query must be a fixed point.
  const second = rewritePromTokens(lex(first.query, 'promql'), projectId);
  if (second.injected !== 0 || second.query !== first.query) fail('query could not be scoped to the project');
  return first.query;
}

// ---------------------------------------------------------------------------
// LogQL
// ---------------------------------------------------------------------------

export type LokiScopeMode = 'stream' | 'metadata';

function rewriteLogTokens(tokens: Tok[], projectId: string, mode: LokiScopeMode): PromRewrite {
  const out: Tok[] = [];
  let injected = 0;
  let selectors = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct' && t.text === '}') fail('unbalanced }');
    if (!(t.kind === 'punct' && t.text === '{')) { out.push(t); continue; }
    const sel = parseSelector(tokens, i, 'logql', projectId);
    if (++selectors > MAX_SELECTORS) fail('too many selectors in query');
    if (mode === 'stream') {
      if (!sel.hadOwn) injected++;
      out.push({ ...scopedSelector(sel.matchers, projectId), gap: t.gap });
      i = sel.end;
      continue;
    }
    // Metadata mode: keep the user's stream matchers (Loki needs one that is
    // non-empty) and filter on the project label immediately after the selector,
    // before any user parser stage can create labels.
    const filter = `| ${PROJECT_LABEL}=${quote(projectId)}`;
    const following = tokens.slice(sel.end + 1, sel.end + 3).map((x) => x.text).join(' ');
    const alreadyFiltered = following === `| ${PROJECT_LABEL}` && tokens[sel.end + 3]?.text === '=' && tokens[sel.end + 4]?.text === quote(projectId);
    const matchers = sel.matchers.length ? sel.matchers : ['service_name=~".+"'];
    out.push({ kind: 'punct', text: `{${matchers.join(',')}}`, gap: t.gap });
    if (alreadyFiltered) {
      i = sel.end;
      continue;
    }
    injected++;
    out.push({ kind: 'punct', text: filter, gap: true });
    i = sel.end;
  }
  if (selectors === 0) fail('a LogQL query needs a stream selector {...}');
  return { query: render(out), injected };
}

export function scopeLogQL(query: unknown, projectIdRaw: string, mode: LokiScopeMode = 'stream'): string {
  const projectId = assertProjectId(projectIdRaw);
  const src = checkInput(query);
  const first = rewriteLogTokens(lex(src, 'logql'), projectId, mode);
  const second = rewriteLogTokens(lex(first.query, 'logql'), projectId, mode);
  if (second.injected !== 0 || second.query !== first.query) fail('query could not be scoped to the project');
  return first.query;
}

// ---------------------------------------------------------------------------
// TraceQL
// ---------------------------------------------------------------------------

/**
 * Scope a TraceQL query: wrap every spanset filter. Strings are skipped
 * exactly like the Tempo lexer (Go text/scanner) does; char literals and
 * comments are refused because they could hide braces or parentheses.
 */
export function scopeTraceQL(query: unknown, projectIdRaw: string): string {
  const projectId = assertProjectId(projectIdRaw);
  const src = checkInput(query);
  const own = `${TRACE_PROJECT_ATTRIBUTE} = ${quote(projectId)}`;
  let out = '';
  let i = 0;
  let inSpanset = false;
  let depth = 0;
  let content = '';
  let spansets = 0;
  const n = src.length;
  const emit = (s: string) => { if (inSpanset) content += s; else out += s; };
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === '`') {
      const start = i;
      i++;
      if (c === '`') {
        while (i < n && src[i] !== '`') i++;
        if (i >= n) fail('unterminated string');
        i++;
      } else {
        let closed = false;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { if (i + 1 >= n || src[i + 1] === '\n') fail('invalid escape in string'); i += 2; continue; }
          if (d === '\n') fail('unterminated string');
          if (d === '"') { closed = true; i++; break; }
          i++;
        }
        if (!closed) fail('unterminated string');
      }
      emit(src.slice(start, i));
      continue;
    }
    if (c === "'") fail('single-quoted literals are not supported');
    if (c === '#') fail('comments are not supported');
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) fail('comments are not supported');
    if (c === '{') {
      if (inSpanset) fail('nested { is not supported');
      inSpanset = true;
      depth = 0;
      content = '';
      i++;
      continue;
    }
    if (c === '}') {
      if (!inSpanset) fail('unbalanced }');
      if (depth !== 0) fail('unbalanced parentheses inside a spanset filter');
      if (++spansets > MAX_SELECTORS) fail('too many spanset filters in query');
      out += content.trim() ? `{ ${own} && (${content}) }` : `{ ${own} }`;
      inSpanset = false;
      i++;
      continue;
    }
    if (inSpanset && c === '(') depth++;
    if (inSpanset && c === ')') {
      depth--;
      if (depth < 0) fail('unbalanced parentheses inside a spanset filter');
    }
    emit(c);
    i++;
  }
  if (inSpanset) fail('unterminated spanset filter');
  if (spansets === 0) fail('a TraceQL query needs a spanset filter {...}');
  return out;
}

// ---------------------------------------------------------------------------
// Server-built selectors
// ---------------------------------------------------------------------------

const SAFE_VALUE_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

/** Validate a user-supplied label value (service, environment, ...). Returns null when empty. */
export function labelValue(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !SAFE_VALUE_RE.test(v)) fail(`invalid ${field}`);
  return v;
}

/** `{platform_project_id="<id>", k="v", ...}` from validated values. */
export function promSelector(projectIdRaw: string, extra: Record<string, string | null | undefined> = {}, raw: string[] = []): string {
  const projectId = assertProjectId(projectIdRaw);
  const parts = [`${PROJECT_LABEL}=${quote(projectId)}`];
  for (const [k, v] of Object.entries(extra)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) fail('invalid label name');
    if (k === PROJECT_LABEL) fail('cannot override the project label');
    if (v !== null && v !== undefined && v !== '') parts.push(`${k}=${quote(v)}`);
  }
  return `{${[...parts, ...raw].join(',')}}`;
}

export const PROFILE_TYPE_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]*:[a-z0-9_]*$/;

/** Pyroscope query `<profileType>{platform_project_id="<id>",...}`. */
export function pyroscopeQuery(projectIdRaw: string, profileType: string, service: string | null, environment: string | null): string {
  if (!PROFILE_TYPE_RE.test(profileType)) fail('invalid profile type');
  return `${profileType}${promSelector(projectIdRaw, { platform_service: service, deployment_environment: environment })}`;
}

const DURATION_RE = /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)$/;

export interface TraceSearchParams {
  service?: string | null;
  name?: string | null;
  environment?: string | null;
  minDuration?: string | null;
  maxDuration?: string | null;
  status?: string | null;
}

/** Build a TraceQL query from structured search fields (scoped afterwards like any query). */
export function buildTraceQL(p: TraceSearchParams): string {
  const conds: string[] = [];
  if (p.service) conds.push(`resource.service.name = ${quote(p.service)}`);
  if (p.environment) conds.push(`resource.deployment.environment = ${quote(p.environment)}`);
  if (p.name) conds.push(`name = ${quote(p.name)}`);
  if (p.minDuration) { if (!DURATION_RE.test(p.minDuration)) fail('invalid minDuration'); conds.push(`duration >= ${p.minDuration}`); }
  if (p.maxDuration) { if (!DURATION_RE.test(p.maxDuration)) fail('invalid maxDuration'); conds.push(`duration <= ${p.maxDuration}`); }
  if (p.status) {
    if (!['error', 'ok', 'unset'].includes(p.status)) fail('invalid status');
    conds.push(`status = ${p.status}`);
  }
  return `{ ${conds.join(' && ')} }`;
}

export interface LogSearchParams {
  service?: string | null;
  environment?: string | null;
  level?: string | null;
  search?: string | null;
  traceId?: string | null;
}

/** Build a LogQL log query from structured filters (scoped afterwards like any query). */
export function buildLogQL(p: LogSearchParams): string {
  const sel: string[] = [];
  if (p.service) sel.push(`service_name=${quote(p.service)}`);
  if (p.environment) sel.push(`deployment_environment=${quote(p.environment)}`);
  let q = `{${sel.join(',')}}`;
  if (p.traceId) {
    if (!/^[0-9a-fA-F]{16,32}$/.test(p.traceId)) fail('invalid traceId');
    q += ` | trace_id=${quote(p.traceId.toLowerCase())}`;
  }
  if (p.level) {
    if (!/^[a-zA-Z]{1,16}$/.test(p.level)) fail('invalid level');
    q += ` | severity_text=~${quote(`(?i)${p.level}`)} or detected_level=~${quote(`(?i)${p.level}`)} or level=~${quote(`(?i)${p.level}`)}`;
  }
  if (p.search) q += ` |= ${quote(p.search)}`;
  return q;
}
