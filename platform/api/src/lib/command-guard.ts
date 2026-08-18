export type CommandRiskLevel = 'read' | 'mutating' | 'destructive' | 'denied';

export interface CommandValidationResult {
  allowed: boolean;
  riskLevel: CommandRiskLevel;
  matchedPolicy: string;
  requiresConfirm: boolean;
  requiresHumanApproval: boolean;
  requiresReason: boolean;
  message: string;
  normalizedCommand: string;
}

interface PolicyRule {
  name: string;
  riskLevel: CommandRiskLevel;
  pattern: RegExp;
  requiresReason?: boolean;
}

/** Denied patterns are evaluated first and always reject. */
const DENIED_RULES: PolicyRule[] = [
  {
    name: 'deny-rm-rf-root',
    riskLevel: 'denied',
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*\s--force\s).*(\/|\s\/\s|\s\/\*|$)/i,
  },
  {
    name: 'deny-recursive-wipe',
    riskLevel: 'denied',
    pattern: /\brm\s+-rf\s+(\/|\/\*|~|\$HOME)\b/i,
  },
  {
    name: 'deny-dd-disk',
    riskLevel: 'denied',
    pattern: /\bdd\s+.*\bif=\/dev\//i,
  },
  {
    name: 'deny-mkfs',
    riskLevel: 'denied',
    pattern: /\bmkfs(\.|$|\s)/i,
  },
  {
    name: 'deny-disable-auth',
    riskLevel: 'denied',
    pattern: /\b(disable[-_ ]?(auth|rbac|admission)|kubectl\s+delete\s+.*\b(clusterrole|rolebinding)\b)/i,
  },
  {
    name: 'deny-secret-exfil',
    riskLevel: 'denied',
    pattern: /\b(curl|wget)\b.*\b(secrets?|password|token)\b.*\bhttps?:\/\//i,
  },
  {
    name: 'deny-arbitrary-remote',
    riskLevel: 'denied',
    pattern: /\b(curl|wget)\s+[^\n]*\bhttps?:\/\/(?!(localhost|127\.0\.0\.1|registry\.|ghcr\.io|github\.com))/i,
  },
  {
    name: 'deny-drop-database',
    riskLevel: 'denied',
    pattern: /\b(drop\s+(database|schema)|DROP\s+DATABASE)\b/,
  },
  {
    name: 'deny-fork-bomb',
    riskLevel: 'denied',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  },
];

const ALLOW_RULES: PolicyRule[] = [
  // Read-only
  { name: 'kubectl-get', riskLevel: 'read', pattern: /^\s*kubectl\s+(get|describe|top|api-resources|api-versions|version|cluster-info)\b/i },
  { name: 'kubectl-logs', riskLevel: 'read', pattern: /^\s*kubectl\s+logs\b/i },
  { name: 'kubectl-explain', riskLevel: 'read', pattern: /^\s*kubectl\s+explain\b/i },
  { name: 'helm-status', riskLevel: 'read', pattern: /^\s*helm\s+(status|list|ls|get|history|show)\b/i },
  { name: 'platformctl-status', riskLevel: 'read', pattern: /^\s*platformctl\s+(status|version|info|health)\b/i },
  { name: 'system-readonly', riskLevel: 'read', pattern: /^\s*(uname|hostname|uptime|df|free|ps|env|printenv|whoami|id|date|pwd|ls|cat|head|tail|wc)\b/i },

  // Mutating
  {
    name: 'kubectl-rollout',
    riskLevel: 'mutating',
    pattern: /^\s*kubectl\s+rollout\s+(restart|status|undo|pause|resume)\b/i,
    requiresReason: true,
  },
  {
    name: 'kubectl-scale',
    riskLevel: 'mutating',
    pattern: /^\s*kubectl\s+scale\b/i,
    requiresReason: true,
  },
  {
    name: 'kubectl-apply',
    riskLevel: 'mutating',
    pattern: /^\s*kubectl\s+apply\b/i,
    requiresReason: true,
  },
  {
    name: 'kubectl-annotate-label',
    riskLevel: 'mutating',
    pattern: /^\s*kubectl\s+(annotate|label)\b/i,
    requiresReason: true,
  },
  {
    name: 'helm-upgrade',
    riskLevel: 'mutating',
    pattern: /^\s*helm\s+(upgrade|install|rollback)\b/i,
    requiresReason: true,
  },

  // Destructive (human approval)
  {
    name: 'kubectl-delete',
    riskLevel: 'destructive',
    pattern: /^\s*kubectl\s+delete\b/i,
    requiresReason: true,
  },
  {
    name: 'kubectl-drain',
    riskLevel: 'destructive',
    pattern: /^\s*kubectl\s+(drain|cordon|uncordon)\b/i,
    requiresReason: true,
  },
  {
    name: 'helm-uninstall',
    riskLevel: 'destructive',
    pattern: /^\s*helm\s+(uninstall|delete)\b/i,
    requiresReason: true,
  },
  {
    name: 'platformctl-destroy',
    riskLevel: 'destructive',
    pattern: /^\s*platformctl\s+(destroy|teardown|reset)\b/i,
    requiresReason: true,
  },
];

export function normalizeCommand(command: string): string {
  return String(command || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateCommand(command: string): CommandValidationResult {
  const normalizedCommand = normalizeCommand(command);

  if (!normalizedCommand) {
    return {
      allowed: false,
      riskLevel: 'denied',
      matchedPolicy: 'empty-command',
      requiresConfirm: false,
      requiresHumanApproval: false,
      requiresReason: false,
      message: 'Command must be a non-empty string',
      normalizedCommand,
    };
  }

  if (normalizedCommand.includes('&&') || normalizedCommand.includes(';') || normalizedCommand.includes('|') || normalizedCommand.includes('`')) {
    return {
      allowed: false,
      riskLevel: 'denied',
      matchedPolicy: 'deny-shell-chaining',
      requiresConfirm: false,
      requiresHumanApproval: false,
      requiresReason: false,
      message: 'Shell chaining / piping / substitution is not allowed. Submit a single allowlisted command.',
      normalizedCommand,
    };
  }

  for (const rule of DENIED_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return {
        allowed: false,
        riskLevel: 'denied',
        matchedPolicy: rule.name,
        requiresConfirm: false,
        requiresHumanApproval: false,
        requiresReason: false,
        message: `Command denied by policy: ${rule.name}`,
        normalizedCommand,
      };
    }
  }

  for (const rule of ALLOW_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      const requiresHumanApproval = rule.riskLevel === 'destructive';
      const requiresConfirm = rule.riskLevel !== 'read';
      const requiresReason = Boolean(rule.requiresReason) || requiresHumanApproval;
      return {
        allowed: true,
        riskLevel: rule.riskLevel,
        matchedPolicy: rule.name,
        requiresConfirm,
        requiresHumanApproval,
        requiresReason,
        message:
          rule.riskLevel === 'read'
            ? 'Read-only command; may execute with agent token.'
            : rule.riskLevel === 'mutating'
              ? 'Mutating command; requires confirm=true and a reason.'
              : 'Destructive command; requires human approval before execute.',
        normalizedCommand,
      };
    }
  }

  return {
    allowed: false,
    riskLevel: 'denied',
    matchedPolicy: 'no-matching-policy',
    requiresConfirm: false,
    requiresHumanApproval: false,
    requiresReason: false,
    message: 'Command does not match any allowlisted policy',
    normalizedCommand,
  };
}
