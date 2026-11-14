import { UserRole } from '../entities/User';

/**
 * Scopes a person can grant to an AI assistant connecting through the remote MCP endpoint.
 * They are the existing agent-token scopes that MCP tools use. Each scope has a role ceiling:
 * a person can only grant what their own role could do in the API, and the ceiling is applied
 * again on every request (so a later role change narrows existing connections at once).
 *
 * `default` scopes are ticked on the consent screen; all of them are read-only.
 */
export interface McpScopeDef {
  id: string;
  label: string;
  description: string;
  /** Roles that may grant (and use) this scope. */
  roles: UserRole[];
  /** Ticked by default on the consent screen. */
  default: boolean;
  readOnly: boolean;
}

const ALL_ROLES = [UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD, UserRole.DEVELOPER, UserRole.VIEWER];

export const MCP_SCOPES: McpScopeDef[] = [
  {
    id: 'projects:read',
    label: 'See your projects',
    description: 'List and read the projects you have access to.',
    roles: ALL_ROLES,
    default: true,
    readOnly: true,
  },
  {
    id: 'logs:read',
    label: 'Read logs',
    description: 'Search application logs of your projects.',
    roles: ALL_ROLES,
    default: true,
    readOnly: true,
  },
  {
    id: 'audit:read',
    label: 'Read the audit log',
    description: 'See recent audit log entries.',
    roles: [UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD],
    default: true,
    readOnly: true,
  },
  {
    id: 'cluster:read',
    label: 'See nodes and pods',
    description: 'List cluster nodes and pods, and read pod logs.',
    roles: [UserRole.ADMIN, UserRole.DEVOPS],
    default: true,
    readOnly: true,
  },
  {
    id: 'bootstrap:read',
    label: 'See install status',
    description: 'Read the installation and infrastructure status.',
    roles: [UserRole.ADMIN, UserRole.DEVOPS],
    default: true,
    readOnly: true,
  },
  {
    id: 'commands:validate',
    label: 'Check commands against the policy',
    description: 'Ask whether a cluster command is allowed. Risky commands open an approval request.',
    roles: [UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD],
    default: false,
    readOnly: false,
  },
  {
    id: 'commands:execute',
    label: 'Run allowed commands',
    description: 'Run allowlisted cluster commands. Risky ones still wait for a person to approve them.',
    roles: [UserRole.ADMIN, UserRole.DEVOPS],
    default: false,
    readOnly: false,
  },
];

export const MCP_SCOPE_IDS = MCP_SCOPES.map((s) => s.id);

export function isMcpScope(id: unknown): id is string {
  return typeof id === 'string' && MCP_SCOPE_IDS.includes(id);
}

/** Scopes a user with `role` may grant or use. Unknown roles get nothing. */
export function allowedScopesForRole(role: string | null | undefined): string[] {
  return MCP_SCOPES.filter((s) => s.roles.includes(role as UserRole)).map((s) => s.id);
}

/** Space-delimited OAuth `scope` string -> known MCP scopes (unknown ones are dropped). */
export function parseScopeParam(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  for (const part of raw.split(/\s+/)) {
    if (isMcpScope(part)) seen.add(part);
  }
  return MCP_SCOPE_IDS.filter((id) => seen.has(id));
}

/** Default (read-only) scopes, limited to the role ceiling. */
export function defaultScopesForRole(role: string | null | undefined): string[] {
  const allowed = new Set(allowedScopesForRole(role));
  return MCP_SCOPES.filter((s) => s.default && allowed.has(s.id)).map((s) => s.id);
}

/** Granted scopes that the user's current role still allows (applied on every request). */
export function effectiveScopes(granted: unknown, role: string | null | undefined): string[] {
  const allowed = new Set(allowedScopesForRole(role));
  const list = Array.isArray(granted) ? granted : [];
  return MCP_SCOPE_IDS.filter((id) => list.includes(id) && allowed.has(id));
}

/** Scope options for the consent screen. */
export function consentScopeOptions(requested: string[], role: string | null | undefined) {
  const allowed = new Set(allowedScopesForRole(role));
  const requestedSet = new Set(requested);
  const asked = requested.length > 0;
  return MCP_SCOPES.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    readOnly: s.readOnly,
    allowed: allowed.has(s.id),
    requested: requestedSet.has(s.id),
    // Tick read-only scopes the assistant asked for (or the defaults when it asked for none).
    checked: allowed.has(s.id) && s.readOnly && (asked ? requestedSet.has(s.id) : s.default),
  }));
}
