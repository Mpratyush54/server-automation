// Clip: connect an AI assistant over MCP and run a scoped command.
//
// Two panes side by side (joined by post/process.mjs):
//   left  (820x800)  the portal's AI agents view: create an agent token with
//                    only the command permissions, then approve a held command;
//   right (460x800)  an MCP client using that token against <CAIRN_URL>/mcp:
//                    it lists pods (allowed at once) and asks to scale the
//                    app (held until a person approves).
// The token is blurred on screen and never written to disk; it is revoked
// at the end of the run.
//
// Env: CAIRN_URL + sign-in (an Admin or DevOps account with two-factor
// sign-in: creating tokens and approving need a recent code, so set
// CAIRN_TOTP_SECRET), MCP_PROJECT_ID (any project, for the AI agents view),
// MCP_NAMESPACE and MCP_DEPLOYMENT (the demo app; scaling keeps
// MCP_REPLICAS, default 2), optional MCP_CLIENT_CMD (a real assistant's
// command line; it gets CAIRN_URL and CAIRN_AGENT_TOKEN in its environment).
import { fileURLToPath } from 'node:url';
import { cairnUrl, env } from '../lib/config.mjs';
import { Recording, beat, click, response, type } from '../lib/recorder.mjs';
import { api } from '../lib/session.mjs';
import { Terminal } from '../lib/terminal.mjs';
import { freshTotp } from '../lib/totp.mjs';

let lastStep = -1;

/** Answer the portal's two-factor step-up dialog if it appears. */
async function stepUp(page) {
  const dialog = page.getByRole('dialog');
  try {
    await dialog.getByLabel('Authentication code').waitFor({ timeout: 4000 });
  } catch {
    return;
  }
  const { code, step } = await freshTotp(env('CAIRN_TOTP_SECRET', { required: true }), lastStep);
  lastStep = step;
  await type(page, dialog.getByLabel('Authentication code'), code);
  await click(page, dialog.getByRole('button', { name: 'Verify', exact: true }));
  await dialog.waitFor({ state: 'detached' });
}

export async function record() {
  const projectId = env('MCP_PROJECT_ID', { required: true });
  const namespace = env('MCP_NAMESPACE', { required: true });
  const deployment = env('MCP_DEPLOYMENT', { required: true });
  const tokenName = `recording-${new Date().toISOString().slice(0, 10)}`;

  const rec = await Recording.open('mcp', [
    { name: 'main', viewport: { width: 820, height: 800 }, signedIn: true },
    { name: 'term', viewport: { width: 460, height: 800 }, signedIn: false },
  ]);
  let tokenId;
  let client;
  try {
    const page = rec.page('main');
    // Never show the secret: blur it wherever the portal prints it.
    await page.addInitScript({ content: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.pa-secret, [data-testid=agents-config] { filter: blur(7px); }'; document.head.appendChild(s); });` });
    await page.goto(`${cairnUrl()}/projects/${encodeURIComponent(projectId)}?tab=monitoring&view=agents`);
    const tokens = page.getByTestId('agents-tokens');
    await tokens.waitFor();
    const term = await Terminal.open(rec.page('term'), { title: 'AI assistant, connected over MCP', fontSize: 13 });
    rec.mark('start');
    await beat(1200);

    // 1. An agent token that may only check and run allowed commands.
    await click(page, page.getByTestId('agents-create-open'));
    const form = page.getByTestId('agents-create-form');
    await type(page, form.getByLabel('Name', { exact: true }), tokenName);
    for (const box of await form.locator('input[type="checkbox"]').all()) {
      const name = await box.getAttribute('name');
      const wanted = name === 'scope-commands:validate' || name === 'scope-commands:execute';
      if ((await box.isChecked()) !== wanted) await click(page, box);
    }
    rec.mark('scopes');
    await beat(1200);
    const created = response(page, /\/api\/agent-tokens$/, { status: [200, 201] });
    await click(page, form.getByRole('button', { name: 'Create token', exact: true }));
    await stepUp(page);
    const body = await (await created).json();
    tokenId = body.id ?? body.token?.id;
    const secret = body.token?.token ?? body.token;
    if (typeof secret !== 'string' || !secret.startsWith('plat_agent_')) throw new Error('No agent token in the response');
    await page.getByTestId('agents-created-token').waitFor();
    rec.mark('token');
    await beat(1500);
    await click(page, page.getByTestId('agents-created-token').getByRole('button', { name: 'Done', exact: true }));

    // 2. The assistant uses it: reading pods works, scaling is held.
    const clientEnv = { ...process.env, CAIRN_URL: cairnUrl(), CAIRN_AGENT_TOKEN: secret };
    const custom = env('MCP_CLIENT_CMD');
    const argv = custom ? ['bash', '-c', custom] : ['node', fileURLToPath(new URL('../lib/mcp-client.mjs', import.meta.url)), namespace, deployment];
    client = await term.run(argv, { env: clientEnv, shown: custom ?? `assistant: check the ${deployment} pods, then scale it to ${env('MCP_REPLICAS', { fallback: '2' })}` });
    rec.mark('client');
    const pending = page.getByTestId('agents-pending');
    // Find the held command through the API (works for any client): this token's scale request.
    const scaleCommand = `kubectl scale deployment ${deployment}`;
    let approval;
    for (let i = 0; i < 240 && !approval; i++) {
      const list = await api('/agent/commands/pending').catch(() => []);
      const items = Array.isArray(list) ? list : list.items ?? list.approvals ?? [];
      approval = items.find((a) => String(a.command).startsWith(scaleCommand) && (!a.requestedByAgentTokenId || a.requestedByAgentTokenId === tokenId));
      if (!approval) await new Promise((r) => setTimeout(r, 500));
    }
    if (!approval) throw new Error('No scale command is waiting for approval');
    rec.mark('held');
    await beat(1500);

    // 3. A person approves it in the portal.
    await pending.scrollIntoViewIfNeeded();
    await click(page, pending.getByRole('button', { name: 'Refresh', exact: true }));
    const row = pending.getByRole('row').filter({ hasText: approval.command });
    await row.waitFor({ timeout: 30_000 });
    rec.mark('pending');
    await beat(1500);
    const approved = response(page, /\/api\/agent\/commands\/[^/]+\/approve/);
    await click(page, row.getByTestId('agents-approve'));
    await stepUp(page);
    await approved;
    await row.waitFor({ state: 'detached', timeout: 30_000 });
    rec.mark('approved');
    client.child.stdin.write('approved\n');
    const { code } = await client.done;
    if (code !== 0) throw new Error(`The MCP client exited with ${code}`);
    rec.mark('ran');
    await beat(3000);
    rec.mark('end');
    await rec.close();
  } catch (error) {
    await client?.finish().catch(() => {});
    await rec.abort();
    throw error;
  } finally {
    if (tokenId) await api(`/agent-tokens/${tokenId}`, { method: 'DELETE' }).catch((e) => console.warn(`Revoke the token "${tokenName}" by hand: ${e.message}`));
  }
}
