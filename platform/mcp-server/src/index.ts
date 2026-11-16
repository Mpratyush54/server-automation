#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlatformClient } from './client.js';
import { buildMcpServer, registerResources } from './shared/registry.js';
import { registerTools } from './tools/index.js';

async function main(): Promise<void> {
  const client = new PlatformClient();
  const tools = registerTools(client);
  const resources = registerResources(() => client.fetchOpenApi());
  const server = buildMcpServer(tools, resources, { name: 'platform-mcp-server', version: '1.0.0' });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[platform-mcp-server] Fatal error:', err);
  process.exit(1);
});
