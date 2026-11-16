import { getOidcIssuer } from './oidc-issuer';
import { MCP_SCOPE_IDS } from './mcp-scopes';

/**
 * Public addresses of the remote MCP endpoint and its OAuth metadata (#193).
 *
 * Like the OIDC issuer, they come from configuration only, never from the request's Host
 * header: MCP_PUBLIC_URL wins, otherwise https://${DOMAIN}. When neither is set the remote MCP
 * endpoint and dynamic registration refuse to work (503), because tokens must be bound to a
 * fixed audience and the metadata must not be spoofable.
 */
export function getPublicBaseUrl(): string | null {
  const explicit = String(process.env.MCP_PUBLIC_URL || '').trim();
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
    return null;
  }
  const domain = String(process.env.DOMAIN || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (domain && /^[A-Za-z0-9.-]+(:\d+)?$/.test(domain)) return `https://${domain}`;
  return null;
}

export const MCP_PATH = '/mcp';
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** Canonical resource identifier (RFC 8707 / RFC 9728) of the MCP endpoint. */
export function getMcpResourceUrl(): string | null {
  const base = getPublicBaseUrl();
  return base ? `${base}${MCP_PATH}` : null;
}

/** RFC 9728 metadata URL for the MCP resource (path-inserted form). */
export function getResourceMetadataUrl(): string | null {
  const base = getPublicBaseUrl();
  return base ? `${base}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}` : null;
}

/** `resource` parameter matches our MCP endpoint (trailing slash tolerated). */
export function isOurMcpResource(value: unknown): boolean {
  const ours = getMcpResourceUrl();
  if (!ours || typeof value !== 'string' || !value || value.length > 500) return false;
  return value.replace(/\/+$/, '') === ours;
}

export const MCP_UNCONFIGURED_MESSAGE =
  'Remote MCP is not available: the server has no public address configured (set DOMAIN or MCP_PUBLIC_URL).';

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(): Record<string, unknown> | null {
  const resource = getMcpResourceUrl();
  if (!resource) return null;
  return {
    resource,
    authorization_servers: [getOidcIssuer()],
    scopes_supported: MCP_SCOPE_IDS,
    bearer_methods_supported: ['header'],
    resource_name: 'Cairn',
    resource_documentation: `${getPublicBaseUrl()}/docs/mcp/setup`,
  };
}

/**
 * RFC 8414 authorization server metadata for the built-in provider, including dynamic client
 * registration, refresh tokens and revocation. Also merged into the OIDC discovery document.
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  const issuer = getOidcIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'profile', 'email', 'groups', ...MCP_SCOPE_IDS],
    service_documentation: getPublicBaseUrl() ? `${getPublicBaseUrl()}/docs/mcp/setup` : undefined,
  };
}
