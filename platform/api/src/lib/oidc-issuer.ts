/**
 * Fixed OIDC issuer for the built-in provider.
 *
 * OIDC_ISSUER wins; otherwise https://${DOMAIN}/api/oauth. It is never derived from the request
 * Host / X-Forwarded-Proto headers: relying parties call token/userinfo/jwks over the in-cluster
 * URL (http://platform-api.platform.svc.cluster.local:3000/api/oauth/...) and must still receive
 * iss = the public issuer, and a spoofed Host header must not change discovery or `iss`.
 */
const FALLBACK_ISSUER = 'http://localhost:3000/api/oauth';
let warnedFallback = false;

export function getOidcIssuer(): string {
  const explicit = String(process.env.OIDC_ISSUER || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const domain = String(process.env.DOMAIN || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (domain) return `https://${domain}/api/oauth`;

  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(`[oidc] Neither OIDC_ISSUER nor DOMAIN is set — using ${FALLBACK_ISSUER} as the issuer.`);
  }
  return FALLBACK_ISSUER;
}
