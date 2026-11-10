/**
 * Authoritative server-side PII scrubbing (#47).
 * Client-side masking in the SDKs is defence-in-depth only.
 *
 * Built-in rules cover emails, auth tokens / JWTs / SDK keys, payment card-like
 * digit runs, and (optionally) IPv4/IPv6 addresses. Projects may add extra
 * regex rules via TelemetryPrivacySettings.scrubRules.
 */

export type ScrubTarget = 'logs' | 'spans' | 'events' | 'all';

export interface ScrubRule {
  /** Stable id (built-in ids are reserved: email, token, card, ipv4, ipv6). */
  id: string;
  name?: string;
  /** JavaScript RegExp source (no surrounding slashes). */
  pattern: string;
  /** Replacement string. Default `[REDACTED]`. */
  replacement?: string;
  /** RegExp flags; default `gi`. */
  flags?: string;
  enabled?: boolean;
  /** Where the rule applies. Default `all`. */
  targets?: ScrubTarget[];
}

export interface ScrubOptions {
  /** Drop IPv4/IPv6 matches. Default true. */
  scrubIps?: boolean;
  /** Extra project rules, applied after built-ins. */
  extraRules?: ScrubRule[];
  /** Limit application to one telemetry kind. */
  target?: ScrubTarget;
}

const EMAIL =
  /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const TOKEN_AUTH =
  /(authorization\s*[:=]\s*)(bearer|basic)?\s*[^\s,;"'}]+/gi;
const TOKEN_BEARER =
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_SDK =
  /\b(sdk_(?:live|test)_|plat_agent_|plat_ingest_(?:web_)?)[A-Za-z0-9._-]+/g;
const TOKEN_JWT =
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const TOKEN_COOKIE =
  /((?:set-)?cookie\s*[:=]\s*)[^\n]+/gi;
const TOKEN_SECRET_FIELD =
  /(["']?\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:id)?)\b["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi;
/** 13–19 digit runs with optional spaces/dashes (card-like). Validated with Luhn when possible. */
const CARD_CANDIDATE =
  /\b(?:\d[ -]*?){13,19}\b/g;
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

export const BUILTIN_SCRUB_RULES: ScrubRule[] = [
  { id: 'email', name: 'Email addresses', pattern: EMAIL.source, flags: 'gi', replacement: '[EMAIL]', targets: ['all'] },
  { id: 'token', name: 'Auth tokens and secrets', pattern: '(?:authorization\\s*[:=]\\s*(?:bearer|basic)?\\s*[^\\s,;"\'}]+)|(?:\\b(?:bearer|basic)\\s+[A-Za-z0-9._~+/=-]+)|(?:\\b(?:sdk_(?:live|test)_|plat_agent_|plat_ingest_(?:web_)?)[A-Za-z0-9._-]+)|(?:\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)|(?:(?:set-)?cookie\\s*[:=]\\s*[^\\n]+)|(?:["\']?\\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:id)?)\\b["\']?\\s*[:=]\\s*["\']?[^\\s"\',;&}]+)', flags: 'gi', replacement: '[REDACTED]', targets: ['all'] },
  { id: 'card', name: 'Payment card numbers', pattern: CARD_CANDIDATE.source, flags: 'g', replacement: '[CARD]', targets: ['all'] },
  { id: 'ipv4', name: 'IPv4 addresses', pattern: IPV4.source, flags: 'g', replacement: '[IP]', targets: ['all'] },
  { id: 'ipv6', name: 'IPv6 addresses', pattern: IPV6.source, flags: 'gi', replacement: '[IP]', targets: ['all'] },
];

/** Luhn check for card-like digit strings (spaces/dashes stripped). */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ruleApplies(rule: ScrubRule, target: ScrubTarget | undefined): boolean {
  if (rule.enabled === false) return false;
  const targets = rule.targets?.length ? rule.targets : ['all'];
  if (!target || target === 'all') return true;
  return targets.includes('all') || targets.includes(target);
}

function compileRule(rule: ScrubRule): { re: RegExp; replacement: string; id: string } | null {
  try {
    const flags = rule.flags ?? 'gi';
    return { re: new RegExp(rule.pattern, flags.includes('g') ? flags : `${flags}g`), replacement: rule.replacement ?? '[REDACTED]', id: rule.id };
  } catch {
    return null;
  }
}

function redactCards(text: string, replacement: string): string {
  return text.replace(CARD_CANDIDATE, (m) => (luhnValid(m) ? replacement : m));
}

/** Apply built-in + project rules to a single string. */
export function scrubText(text: string, opts: ScrubOptions = {}): string {
  if (!text) return text;
  const scrubIps = opts.scrubIps !== false;
  const target = opts.target ?? 'all';
  let out = text;

  // Built-ins (order matters: secrets before generic digit runs).
  if (ruleApplies(BUILTIN_SCRUB_RULES[0], target)) out = out.replace(EMAIL, '[EMAIL]');
  if (ruleApplies(BUILTIN_SCRUB_RULES[1], target)) {
    out = out.replace(TOKEN_AUTH, '$1[REDACTED]');
    out = out.replace(TOKEN_BEARER, '$1 [REDACTED]');
    out = out.replace(TOKEN_SDK, '$1[REDACTED]');
    out = out.replace(TOKEN_JWT, '[REDACTED_JWT]');
    out = out.replace(TOKEN_COOKIE, '$1[REDACTED]');
    out = out.replace(TOKEN_SECRET_FIELD, '$1[REDACTED]');
  }
  if (ruleApplies(BUILTIN_SCRUB_RULES[2], target)) out = redactCards(out, '[CARD]');
  if (scrubIps) {
    if (ruleApplies(BUILTIN_SCRUB_RULES[3], target)) out = out.replace(IPV4, '[IP]');
    if (ruleApplies(BUILTIN_SCRUB_RULES[4], target)) out = out.replace(IPV6, '[IP]');
  }

  for (const rule of opts.extraRules || []) {
    if (!ruleApplies(rule, target)) continue;
    if (['email', 'token', 'card', 'ipv4', 'ipv6'].includes(rule.id) && rule.enabled === false) continue;
    const compiled = compileRule(rule);
    if (!compiled) continue;
    if (rule.id === 'card') {
      out = redactCards(out, compiled.replacement);
    } else {
      out = out.replace(compiled.re, compiled.replacement);
    }
  }
  return out;
}

const MAX_DEPTH = 8;

/** Deep-scrub every string in a JSON-compatible value. */
export function scrubValue<T>(value: T, opts: ScrubOptions = {}, depth = 0): T {
  if (value == null || depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return scrubText(value, opts) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, opts, depth + 1)) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, opts, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Validate a project-supplied rule before persistence. */
export function validateScrubRule(raw: unknown): { ok: true; rule: ScrubRule } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'rule must be an object' };
  const r = raw as Record<string, unknown>;
  const id = String(r.id || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(id)) return { ok: false, error: 'id must be 1..64 alphanumeric/_.-' };
  const pattern = String(r.pattern || '');
  if (!pattern || pattern.length > 512) return { ok: false, error: 'pattern required (max 512 chars)' };
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, String(r.flags || 'gi'));
  } catch {
    return { ok: false, error: 'pattern is not a valid regular expression' };
  }
  const replacement = r.replacement == null ? '[REDACTED]' : String(r.replacement).slice(0, 64);
  const flags = r.flags == null ? 'gi' : String(r.flags).slice(0, 8);
  const enabled = r.enabled !== false;
  const targetsRaw = Array.isArray(r.targets) ? r.targets.map(String) : ['all'];
  const allowed: ScrubTarget[] = ['logs', 'spans', 'events', 'all'];
  const targets = targetsRaw.filter((t): t is ScrubTarget => (allowed as string[]).includes(t));
  return {
    ok: true,
    rule: {
      id,
      name: r.name == null ? undefined : String(r.name).slice(0, 120),
      pattern,
      replacement,
      flags,
      enabled,
      targets: targets.length ? targets : ['all'],
    },
  };
}

/** Public catalogue of built-in rules (no compiled RegExp objects). */
export function builtinRulesPublic(scrubIps = true): ScrubRule[] {
  return BUILTIN_SCRUB_RULES.map((r) => ({
    ...r,
    enabled: (r.id === 'ipv4' || r.id === 'ipv6') ? scrubIps : r.enabled !== false,
  }));
}
