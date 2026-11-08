/**
 * Strip credentials from anything that is about to be returned to the MCP client.
 * Tool results end up in LLM context, agent transcripts and logs, so they must never
 * carry bearer tokens, passwords or secrets — even when an upstream API echoes them.
 */

export const REDACTED = '[REDACTED]';

// Compared after lower-casing and removing '_' / '-'.
const SECRET_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'agenttoken',
  'sdktoken',
  'apitoken',
  'plaintexttoken',
  'rawtoken',
  'jwt',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'privatekey',
  'secretkey',
  'clientsecret',
  'passwordhash',
  'tokenhash',
  'secrethash',
]);

const SECRET_KEY_SUFFIXES = ['password', 'passwd', 'secret'];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\bplat_agent_[A-Za-z0-9_-]+/g,
  /\bsdk_(?:live|test)_[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  if (SECRET_KEYS.has(k)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const arr = value.map((item) => redactSecrets(item, seen));
    seen.delete(value);
    return arr;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // Scalars under secret-looking keys are dropped; objects are walked (e.g. { token: { id, name } }).
    if (isSecretKey(key) && (typeof inner === 'string' || typeof inner === 'number') && inner !== '') {
      out[key] = REDACTED;
    } else {
      out[key] = redactSecrets(inner, seen);
    }
  }
  seen.delete(value);
  return out;
}
