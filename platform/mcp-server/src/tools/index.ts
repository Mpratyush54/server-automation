import type { PlatformClient } from '../client.js';
import { PlatformApiError } from '../client.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function toolError(err: unknown): ToolResult {
  if (err instanceof PlatformApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: err.message,
              status: err.status,
              body: err.body,
              hint:
                err.status === 401
                  ? 'Set PLATFORM_AGENT_TOKEN or call platform_login with valid credentials.'
                  : undefined,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
  };
}

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export type RegisteredTool = ToolDefinition & {
  handler: ToolHandler;
};

export function registerTools(client: PlatformClient): RegisteredTool[] {
  return [
    {
      name: 'platform_login',
      description:
        'Authenticate with Platform using email and password. Stores a human JWT in memory for subsequent API calls.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'User email address' },
          password: { type: 'string', description: 'User password' },
        },
        required: ['email', 'password'],
      },
      handler: async (args) => {
        try {
          const result = await client.login(String(args.email), String(args.password));
          return jsonResult(result);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_logout',
      description: 'Clear the in-memory human JWT session. Does not affect PLATFORM_AGENT_TOKEN from the environment.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => jsonResult(await client.logout()),
    },
    {
      name: 'platform_whoami',
      description:
        'Return the current authenticated identity. Uses /api/agent-tokens/me for agent tokens or /api/users/me for human JWT.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.whoami());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_health',
      description: 'Check Platform API health (GET /api/health). Does not require authentication.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.health());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_bootstrap_status',
      description: 'Get Platform bootstrap and infrastructure status (GET /api/bootstrap/status).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.bootstrapStatus());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_list_projects',
      description: 'List all projects (GET /api/projects).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.listProjects());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_get_project',
      description: 'Get a single project by ID (GET /api/projects/:id).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Project ID' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        try {
          return jsonResult(await client.getProject(String(args.id)));
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_search_logs',
      description: 'Search application logs (GET /api/logs/search).',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Filter by project ID' },
          environmentId: { type: 'string', description: 'Filter by environment ID' },
          serviceName: { type: 'string', description: 'Filter by service name' },
          level: { type: 'string', description: 'Log level (e.g. info, warn, error)' },
          search: { type: 'string', description: 'Substring search in log messages' },
          limit: { type: 'number', description: 'Max results (default 50)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
        },
      },
      handler: async (args) => {
        try {
          return jsonResult(await client.searchLogs(args as Record<string, string | number | boolean>));
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_get_pod_logs',
      description: 'Fetch Kubernetes pod logs (GET /api/bootstrap/pods/:namespace/:podName/logs).',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Kubernetes namespace' },
          podName: { type: 'string', description: 'Pod name' },
        },
        required: ['namespace', 'podName'],
      },
      handler: async (args) => {
        try {
          return jsonResult(await client.getPodLogs(String(args.namespace), String(args.podName)));
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_audit_logs',
      description: 'List recent audit log entries (GET /api/audit-logs). Requires DEVOPS or TECH_LEAD role.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.auditLogs());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_list_pods',
      description: 'List Kubernetes pods, optionally filtered by namespace (GET /api/bootstrap/pods).',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Optional Kubernetes namespace filter' },
        },
      },
      handler: async (args) => {
        try {
          const namespace = args.namespace ? String(args.namespace) : undefined;
          return jsonResult(await client.listPods(namespace));
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_list_nodes',
      description: 'List Kubernetes cluster nodes (GET /api/bootstrap/nodes).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.listNodes());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_run_command',
      description:
        'Validate and execute an agent command. Calls POST /api/agent/commands/validate then POST /api/agent/commands/execute. Set confirm=true for destructive commands after reviewing validation output.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run on the platform agent' },
          reason: { type: 'string', description: 'Optional justification for the command' },
          confirm: {
            type: 'boolean',
            description: 'Set true to execute after validation, especially for destructive commands',
          },
          approvalId: {
            type: 'string',
            description: 'Approval ID from a human-approved pending command, if required',
          },
        },
        required: ['command'],
      },
      handler: async (args) => {
        try {
          const command = String(args.command);
          const validation = await client.validateCommand(command);

          if (!args.confirm) {
            return jsonResult({
              phase: 'validation',
              validation,
              message: 'Command validated. Re-call with confirm=true to execute.',
            });
          }

          const execution = await client.executeCommand({
            command,
            confirm: true,
            reason: args.reason ? String(args.reason) : undefined,
            approvalId: args.approvalId ? String(args.approvalId) : undefined,
          });

          return jsonResult({
            phase: 'execution',
            validation,
            execution,
          });
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_list_pending_commands',
      description:
        'List commands awaiting human approval (GET /api/agent/commands/pending). Requires a human JWT from platform_login; agent tokens are not supported.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return jsonResult(await client.listPendingCommands());
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_approve_command',
      description:
        'Approve a pending agent command (POST /api/agent/commands/:id/approve). Requires a human JWT from platform_login.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Pending command approval ID' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        try {
          return jsonResult(await client.approveCommand(String(args.id)));
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: 'platform_deploy',
      description:
        'Trigger a deployment (POST /api/deploy). Set confirm=true before submitting destructive or production deployments.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID' },
          environmentId: { type: 'string', description: 'Target environment ID' },
          version: { type: 'string', description: 'Deployment version tag' },
          branch: { type: 'string', description: 'Git branch to deploy' },
          commitSha: { type: 'string', description: 'Git commit SHA' },
          imageTag: { type: 'string', description: 'Container image tag' },
          environmentName: { type: 'string', description: 'Environment name (e.g. preview)' },
          gitPath: { type: 'string', description: 'Path within the git repository' },
          pullFromGit: { type: 'boolean', description: 'Whether to pull latest from git' },
          metadata: { type: 'object', description: 'Additional deployment metadata' },
          confirm: {
            type: 'boolean',
            description: 'Must be true to execute the deployment request',
          },
        },
        required: ['projectId', 'confirm'],
      },
      handler: async (args) => {
        try {
          if (args.confirm !== true) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: 'Deployment not submitted: confirm must be true.',
                      hint: 'Review parameters and call platform_deploy again with confirm=true.',
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          const { confirm: _confirm, ...body } = args;
          return jsonResult(await client.deploy(body as Record<string, unknown>));
        } catch (err) {
          return toolError(err);
        }
      },
    },
  ];
}
