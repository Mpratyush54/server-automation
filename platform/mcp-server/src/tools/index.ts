/**
 * Tool definitions live in the shared registry (platform/api/src/mcp/registry.ts) so this stdio
 * server and the remote /mcp endpoint offer the same tools. This server runs in `local` mode:
 * it also offers platform_login, the approval tools and platform_deploy.
 */
import {
  registerTools as registerSharedTools,
  toolError as sharedToolError,
  type PlatformApi,
  type RegisteredTool,
} from '../shared/registry.js';

export { jsonResult } from '../shared/registry.js';
export type { ToolDefinition, ToolHandler, ToolResult, RegisteredTool } from '../shared/registry.js';

export function registerTools(client: PlatformApi): RegisteredTool[] {
  return registerSharedTools(client, { mode: 'local' });
}

export function toolError(err: unknown) {
  return sharedToolError(err, 'local');
}
