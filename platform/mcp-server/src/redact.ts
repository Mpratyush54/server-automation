/**
 * Strip credentials from anything that is about to be returned to the MCP client.
 * Implemented in the shared registry (platform/api/src/mcp/registry.ts) so the local and the
 * remote server redact the same way.
 */
export { REDACTED, isSecretKey, redactString, redactSecrets } from './shared/registry.js';
