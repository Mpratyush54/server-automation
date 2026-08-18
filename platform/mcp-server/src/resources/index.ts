export const COMMAND_POLICY_MARKDOWN = `# Platform Agent Command Policy

This document describes how MCP agents should use \`platform_run_command\` safely against the Platform PaaS.

## Authentication

- **Agent token** (\`PLATFORM_AGENT_TOKEN\`, \`plat_agent_*\`): default credential for automated agents. Can validate and execute allowlisted commands.
- **Human JWT** (\`platform_login\`): required for approving pending commands and other human-in-the-loop actions.

## Command workflow

1. Call \`platform_run_command\` with \`command\` only.
2. Review the **validation** response (risk level, matched policy, required approvals).
3. If validation passes and execution is appropriate, call again with \`confirm: true\` and an optional \`reason\`.

Never set \`confirm: true\` without reading validation output first.

## Risk tiers

| Tier | Examples | Requirements |
|------|----------|--------------|
| Read-only | \`kubectl get\`, \`kubectl logs\`, status checks | Agent token; auto-approved |
| Mutating | rollout restart, scale, config apply | Agent token; may require \`reason\` |
| Destructive | delete resources, drain nodes, drop databases | Human approval via \`platform_list_pending_commands\` / \`platform_approve_command\` |

## Destructive commands

Destructive commands return a pending approval ID from validation. A human must:

1. \`platform_login\` with their credentials
2. \`platform_list_pending_commands\` to inspect the queue
3. \`platform_approve_command\` with the pending command \`id\`
4. Re-run \`platform_run_command\` with \`confirm: true\` and the \`approvalId\` when prompted

## Deployments

Use \`platform_deploy\` for application releases—not raw shell commands when a deploy API exists.

- Always pass \`confirm: true\` only after verifying \`projectId\`, \`environmentId\`, branch, and image tag.
- Production deploys should include a clear change reason in deployment metadata when supported.

## Denied patterns

Commands matching any of the following are rejected at validation:

- Recursive \`rm -rf /\` or broad filesystem wipes
- Disabling authentication or RBAC
- Exfiltration of secrets outside approved paths
- Arbitrary curl/wget to unknown external hosts without policy match

## Error handling

- **401**: missing or expired credentials — set \`PLATFORM_AGENT_TOKEN\` or \`platform_login\`.
- **403**: insufficient role or policy denial — escalate to a human operator.
- **409**: pending approval already exists for the same command scope.

## Observability

All executed commands are audit-logged. Use \`platform_audit_logs\` and \`platform_search_logs\` to trace agent activity.
`;

export type ResourceDefinition = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
};

export function registerResources(fetchOpenApi: () => Promise<unknown>): ResourceDefinition[] {
  return [
    {
      uri: 'platform://openapi',
      name: 'Platform OpenAPI Specification',
      description: 'Live OpenAPI document fetched from GET /api/openapi.json',
      mimeType: 'application/json',
      read: async () => {
        const spec = await fetchOpenApi();
        return JSON.stringify(spec, null, 2);
      },
    },
    {
      uri: 'platform://command-policy',
      name: 'Platform Agent Command Policy',
      description: 'Static policy guide for safe agent command execution',
      mimeType: 'text/markdown',
      read: async () => COMMAND_POLICY_MARKDOWN,
    },
  ];
}
