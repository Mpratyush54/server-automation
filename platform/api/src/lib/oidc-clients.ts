import * as crypto from 'crypto';

/**
 * Registry of OIDC relying parties allowed to use the built-in provider (/api/oauth/*).
 *
 * Built-in clients and their exact redirect URIs derive from DOMAIN and mirror what platformctl
 * installs (platformctl/internal/manifests/data/*-values.yaml, components.go). Each client secret
 * comes from OIDC_CLIENT_SECRET_<ID> (ID upper-cased, '-' -> '_'). A client without one is NOT
 * registered, because the legacy installer values are public placeholders — unless
 * OIDC_ALLOW_LEGACY_SECRETS=true is set as a temporary migration escape hatch.
 *
 * OIDC_CLIENTS (JSON array of {id, secret, redirectUris, name?}) is authoritative: when set it
 * replaces the built-in registry entirely. The installer writes it into the platform-env secret.
 */
export interface OidcClient {
  id: string;
  name: string;
  secret: string;
  redirectUris: string[];
  /** True when the secret is a publicly-known installer placeholder. */
  legacySecret?: boolean;
}

interface BuiltinClientDef {
  id: string;
  name: string;
  redirectUris: (domain: string) => string[];
  legacySecret: () => string;
}

const BUILTIN_CLIENTS: BuiltinClientDef[] = [
  {
    id: 'grafana',
    name: 'Grafana',
    // root_url https://DOMAIN/grafana/ + generic_oauth callback
    redirectUris: (d) => [`https://${d}/grafana/login/generic_oauth`],
    legacySecret: () => 'grafana-secret-placeholder',
  },
  {
    id: 'argocd',
    name: 'Argo CD',
    // url https://DOMAIN/argocd + /auth/callback
    redirectUris: (d) => [`https://${d}/argocd/auth/callback`],
    legacySecret: () => 'argocd-secret-placeholder',
  },
  {
    id: 'portainer',
    name: 'Portainer',
    // components.go ensurePortainerAdminAndSSO: RedirectURI https://portainer.DOMAIN/
    redirectUris: (d) => [`https://portainer.${d}/`],
    // components.go: WebhookSecret, else JWTSecret, else literal (min 8 chars)
    legacySecret: () => {
      const s = process.env.PLATFORM_WEBHOOK_SECRET || process.env.JWT_SECRET || '';
      return s.length >= 8 ? s : 'portainer-oauth-secret';
    },
  },
  {
    id: 'oauth2-proxy',
    name: 'OAuth2 Proxy',
    // oauth2-proxy-values.yaml redirect_url
    redirectUris: (d) => [`https://${d}/oauth2/callback`],
    legacySecret: () => 'placeholder',
  },
  {
    id: 'minio',
    name: 'MinIO Console',
    // minio-values.yaml MINIO_IDENTITY_OPENID_REDIRECT_URI
    redirectUris: (d) => [`https://minio.${d}/oauth_callback`],
    legacySecret: () => 'minio-secret-placeholder',
  },
];

export function clientSecretEnvName(id: string): string {
  return `OIDC_CLIENT_SECRET_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function normalizeDomain(raw: string | undefined): string {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function parseOverride(raw: string): OidcClient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`OIDC_CLIENTS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('OIDC_CLIENTS must be a JSON array');
  return parsed.map((c: any, i: number) => {
    if (!c || typeof c.id !== 'string' || !c.id) throw new Error(`OIDC_CLIENTS[${i}].id is required`);
    if (typeof c.secret !== 'string' || c.secret.length < 8) {
      throw new Error(`OIDC_CLIENTS[${i}].secret must be a string of at least 8 characters`);
    }
    if (!Array.isArray(c.redirectUris) || c.redirectUris.length === 0 || c.redirectUris.some((u: any) => typeof u !== 'string')) {
      throw new Error(`OIDC_CLIENTS[${i}].redirectUris must be a non-empty string array`);
    }
    for (const u of c.redirectUris as string[]) {
      try {
        new URL(u);
      } catch {
        throw new Error(`OIDC_CLIENTS[${i}].redirectUris contains an invalid URL: ${u}`);
      }
    }
    return {
      id: c.id,
      name: typeof c.name === 'string' && c.name ? c.name : c.id,
      secret: c.secret,
      redirectUris: [...c.redirectUris],
    };
  });
}

let cache: { key: string; clients: OidcClient[] } | null = null;
const warned = new Set<string>();

/** Resolve the client registry from env (memoised per env snapshot). */
export function getOidcClients(): OidcClient[] {
  const domain = normalizeDomain(process.env.DOMAIN);
  const override = process.env.OIDC_CLIENTS || '';
  const secretKeys = BUILTIN_CLIENTS.map((c) => process.env[clientSecretEnvName(c.id)] || '').join('\u0000');
  const allowLegacy = process.env.OIDC_ALLOW_LEGACY_SECRETS === 'true';
  const key = [domain, override, secretKeys, String(allowLegacy), process.env.PLATFORM_WEBHOOK_SECRET || '', process.env.JWT_SECRET || ''].join('\u0001');
  if (cache && cache.key === key) return cache.clients;

  let clients: OidcClient[];
  if (override.trim()) {
    clients = parseOverride(override);
  } else if (!domain) {
    clients = [];
    if (!warned.has('no-domain')) {
      warned.add('no-domain');
      console.warn('[oidc] DOMAIN is not set and OIDC_CLIENTS is empty — no OIDC clients are registered.');
    }
  } else {
    clients = BUILTIN_CLIENTS.flatMap((def) => {
      const envSecret = process.env[clientSecretEnvName(def.id)];
      const legacy = !envSecret;
      if (legacy && !allowLegacy) {
        if (!warned.has(`skip-${def.id}`)) {
          warned.add(`skip-${def.id}`);
          console.warn(`[oidc] Client "${def.id}" is disabled: set OIDC_CLIENTS or ${clientSecretEnvName(def.id)}.`);
        }
        return [];
      }
      if (legacy && !warned.has(def.id)) {
        warned.add(def.id);
        console.warn(`[oidc] ${clientSecretEnvName(def.id)} is not set — client "${def.id}" uses the public legacy installer secret (OIDC_ALLOW_LEGACY_SECRETS=true). Set a unique secret.`);
      }
      return [{
        id: def.id,
        name: def.name,
        secret: envSecret || def.legacySecret(),
        redirectUris: def.redirectUris(domain),
        legacySecret: legacy,
      }];
    });
  }
  cache = { key, clients };
  return clients;
}

export function findOidcClient(clientId: unknown): OidcClient | null {
  if (typeof clientId !== 'string' || !clientId) return null;
  return getOidcClients().find((c) => c.id === clientId) || null;
}

/** Exact string match against the registered redirect URIs (no prefix / wildcard matching). */
export function isRegisteredRedirectUri(client: OidcClient, redirectUri: unknown): boolean {
  return typeof redirectUri === 'string' && client.redirectUris.includes(redirectUri);
}

export function verifyClientSecret(client: OidcClient, presented: unknown): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(client.secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Test hook. */
export function resetOidcClientCache(): void {
  cache = null;
}
