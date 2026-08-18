#!/usr/bin/env node
/**
 * MCP stdio smoke test against a live Platform API.
 * Usage: PLATFORM_URL=https://host npm run smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');
const platformUrl = process.env.PLATFORM_URL || 'http://127.0.0.1:3000';

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      PLATFORM_URL: platformUrl,
    },
  });

  const client = new Client({ name: 'platform-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  if (!names.includes('platform_health') || !names.includes('platform_run_command')) {
    throw new Error(`unexpected tools: ${names.join(', ')}`);
  }

  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri);
  if (!uris.includes('platform://openapi') || !uris.includes('platform://command-policy')) {
    throw new Error(`unexpected resources: ${uris.join(', ')}`);
  }

  const health = await client.callTool({ name: 'platform_health', arguments: {} });
  const healthText = health.content?.[0] && 'text' in health.content[0] ? health.content[0].text : '';
  if (health.isError) {
    throw new Error(`platform_health failed: ${healthText}`);
  }

  const policy = await client.readResource({ uri: 'platform://command-policy' });
  const policyText = policy.contents?.[0] && 'text' in policy.contents[0] ? String(policy.contents[0].text) : '';
  if (!/risk/i.test(policyText)) {
    throw new Error('platform://command-policy did not look like policy markdown');
  }

  const result = {
    ok: true,
    platformUrl,
    toolCount: names.length,
    tools: names,
    resources: uris,
    health: JSON.parse(healthText),
    authenticated: Boolean(process.env.PLATFORM_AGENT_TOKEN),
  };

  if (process.env.PLATFORM_AGENT_TOKEN) {
    const who = await client.callTool({ name: 'platform_whoami', arguments: {} });
    const whoText = who.content?.[0] && 'text' in who.content[0] ? who.content[0].text : '';
    result.whoami = who.isError ? { error: whoText } : JSON.parse(whoText);
  }

  await client.close();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
