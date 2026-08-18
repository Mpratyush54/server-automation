#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PlatformClient } from './client.js';
import { registerResources } from './resources/index.js';
import { registerTools, toolError } from './tools/index.js';

async function main(): Promise<void> {
  const client = new PlatformClient();
  const tools = registerTools(client);
  const resources = registerResources(() => client.fetchOpenApi());
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const resourceMap = new Map(resources.map((resource) => [resource.uri, resource]));

  const server = new Server(
    {
      name: 'platform-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }, null, 2),
          },
        ],
      };
    }

    try {
      return await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
    } catch (err) {
      return toolError(err);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map(({ uri, name, description, mimeType }) => ({
      uri,
      name,
      description,
      mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resourceMap.get(request.params.uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }

    try {
      const text = await resource.read();
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text,
          },
        ],
      };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[platform-mcp-server] Fatal error:', err);
  process.exit(1);
});
