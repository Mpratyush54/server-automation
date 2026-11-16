#!/usr/bin/env node
// A small MCP client for the AI-agents clip. It connects to Cairn's real
// remote MCP endpoint (<CAIRN_URL>/mcp) with an agent token and calls the
// real tools, printing each call and the server's answer. It stands in for
// an assistant's tool calls so the recording is repeatable; to record a real
// assistant instead, set MCP_CLIENT_CMD (see README).
//
// Usage: CAIRN_URL=... CAIRN_AGENT_TOKEN=... node mcp-client.mjs <namespace> <deployment>
// After the scale command is held for approval it waits for a line
// "approved" on stdin (the recording script sends it once a person has
// approved the command in the portal), then runs it.
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [namespace, deployment] = process.argv.slice(2);
const base = process.env.CAIRN_URL?.replace(/\/+$/, '');
const token = process.env.CAIRN_AGENT_TOKEN;
if (!base || !token || !namespace || !deployment) {
  console.error('Usage: CAIRN_URL=... CAIRN_AGENT_TOKEN=... node mcp-client.mjs <namespace> <deployment>');
  process.exit(2);
}

const dim = (s) => `\x1b[38;2;125;131;139m${s}\x1b[0m`;
const amber = (s) => `\x1b[38;2;242;181;58m${s}\x1b[0m`;
const green = (s) => `\x1b[38;2;63;179;127m${s}\x1b[0m`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new Client({ name: 'cairn-recording', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
console.log(green(`connected to ${new URL(base).host}/mcp`));

async function call(name, args) {
  console.log(`\n${amber('tool')} ${name}(${JSON.stringify(args)})`);
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (result.isError) {
    show(parsed);
    throw new Error(`${name} failed`);
  }
  return { result, parsed };
}

function mustHaveRun(parsed) {
  const run = parsed?.execution?.result;
  if (!run || run.ok === false || (run.exitCode !== undefined && run.exitCode !== 0) || run.dryRun) {
    show(parsed);
    console.error('The command did not run successfully');
    process.exit(1);
  }
}

function show(value, max = 14) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const lines = text.split('\n');
  for (const line of lines.slice(0, max)) console.log(dim('  ') + line);
  if (lines.length > max) console.log(dim(`  ... ${lines.length - max} more lines`));
}

// 1. A read-only command: allowed at once.
const pods = `kubectl get pods -n ${namespace}`;
let { parsed } = await call('platform_run_command', { command: pods, confirm: true, reason: 'Check the app is running' });
mustHaveRun(parsed);
show(parsed?.execution?.result?.stdout ?? parsed?.execution ?? parsed);
await sleep(1500);

// 2. A change: validated, then held for a person to approve.
const replicas = Number(process.env.MCP_REPLICAS || 2);
const scale = `kubectl scale deployment ${deployment} --replicas=${replicas} -n ${namespace}`;
({ parsed } = await call('platform_run_command', { command: scale, reason: 'Keep two replicas for the demo' }));
const approvalId = parsed?.validation?.approvalId;
if (!approvalId) {
  show(parsed);
  console.error('The scale command was not held for approval');
  process.exit(1);
}
console.log(amber(`  waiting for a person to approve it in the portal (${approvalId.slice(0, 8)})`));

const lines = createInterface({ input: process.stdin });
for await (const line of lines) if (line.trim() === 'approved') break;
lines.close();

({ parsed } = await call('platform_run_command', { command: scale, confirm: true, approvalId, reason: 'Approved in the portal' }));
mustHaveRun(parsed);
show(parsed?.execution?.result?.stdout ?? parsed?.execution ?? parsed);
await client.close();
