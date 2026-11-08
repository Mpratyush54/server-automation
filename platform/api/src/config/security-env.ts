/**
 * Startup / runtime validation of security-critical environment variables.
 *
 * There are deliberately NO hardcoded fallbacks for secrets: a missing or
 * well-known value must stop the server instead of silently running with a
 * secret that is published in this (public) repository.
 */

/** Literal defaults that shipped in earlier versions — never accept them outside tests. */
export const KNOWN_INSECURE_JWT_SECRETS = new Set<string>([
  'plat-super-secret-key',
]);

/** Literal defaults that must never be used as the encryption master key. */
export const KNOWN_INSECURE_ENCRYPTION_KEYS = new Set<string>([
  'plat-super-secret-key',
  'plat-db-creds-fallback',
]);

export const MIN_JWT_SECRET_LENGTH = 32;

function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test';
}

/**
 * Returns the JWT signing secret. Throws when it is missing, or when it is a
 * known published default (except under NODE_ENV=test so the suite can sign tokens).
 */
export function getJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  if (!isTestEnv(env) && KNOWN_INSECURE_JWT_SECRETS.has(secret)) {
    throw new Error('JWT_SECRET is set to a known insecure default');
  }
  return secret;
}

/**
 * Validate security-critical env at startup. Returns a list of human-readable
 * problems; the caller must refuse to start when the list is non-empty.
 */
export function validateSecurityEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    problems.push('JWT_SECRET is not set. Generate one with: openssl rand -hex 32');
  } else {
    if (KNOWN_INSECURE_JWT_SECRETS.has(jwtSecret)) {
      problems.push('JWT_SECRET is set to the published default "plat-super-secret-key". Rotate it (openssl rand -hex 32).');
    }
    if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
      problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${jwtSecret.length}).`);
    }
  }

  const encKey = env.SECRETS_ENCRYPTION_KEY;
  if (encKey && KNOWN_INSECURE_ENCRYPTION_KEYS.has(encKey)) {
    problems.push('SECRETS_ENCRYPTION_KEY is set to a published default value. Set a unique random key.');
  }

  const adminPassword = env.ADMIN_PASSWORD;
  if (adminPassword && adminPassword === 'Admin@123') {
    problems.push('ADMIN_PASSWORD is set to the published default "Admin@123". Choose a unique password.');
  }

  return problems;
}

/**
 * Parse the CORS allowlist. CORS_ORIGINS is a comma-separated list of origins.
 * Default: https://<DOMAIN> and https://www.<DOMAIN> when DOMAIN is set (the portal
 * is served from the bare domain); http://localhost:4200 is added outside production.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const origins = new Set<string>(explicit);
  if (explicit.length === 0) {
    const domain = (env.DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (domain) {
      origins.add(`https://${domain}`);
      origins.add(`https://www.${domain}`);
    }
  }
  if (env.NODE_ENV !== 'production') {
    origins.add('http://localhost:4200');
  }
  return Array.from(origins);
}
