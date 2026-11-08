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

/**
 * Denied rules are evaluated first and always reject. `pattern` runs against the normalized
 * command string; `test` runs against the parsed argv (the exact argv that command-exec spawns).
 */
interface DenyRule {
  name: string;
  pattern?: RegExp;
  test?: (argv: string[], normalized: string) => boolean;
}

/**
 * Allow rules match on the parsed argv. The binary must be named exactly (no paths, no
 * case folding) and the subcommand must be argv[1] — no global flags before it.
 */
interface AllowRule {
  name: string;
  riskLevel: Exclude<CommandRiskLevel, 'denied'>;
  match: (argv: string[]) => boolean;
  requiresReason?: boolean;
  /** Force a human approval even for non-destructive risk levels (e.g. reading secrets, kubectl apply). */
  requiresHumanApproval?: boolean;
}

/** Hosts curl/wget may reach. Compared against the parsed URL hostname — exact match only. */
const ALLOWED_REMOTE_HOSTS = new Set(['localhost', '127.0.0.1', 'ghcr.io', 'github.com']);

/** kubectl/helm flags that redirect the client to another cluster/identity or run extra binaries. */
const DENIED_CLIENT_FLAGS = [
  '--kubeconfig',
  '--server',
  '-s',
  '--token',
  '--as',
  '--as-group',
  '--as-uid',
  '--username',
  '--password',
  '--client-certificate',
  '--client-key',
  '--certificate-authority',
  '--insecure-skip-tls-verify',
  '--kube-apiserver',
  '--kube-token',
  '--kube-as-user',
  '--kube-as-group',
  '--kube-ca-file',
  '--kube-insecure-skip-tls-verify',
  '--post-renderer',
  '--post-renderer-args',
];

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function extractUrls(argv: string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    const matches = arg.match(/https?:\/\/[^\s'"]+/gi);
    if (matches) urls.push(...matches);
  }
  return urls;
}

function isAllowedRemote(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_REMOTE_HOSTS.has(host);
  } catch {
    return false;
  }
}

const DENIED_RULES: DenyRule[] = [
  {
    name: 'deny-rm-rf-root',
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*\s--force\s).*(\/|\s\/\s|\s\/\*|$)/i,
  },
  {
    name: 'deny-recursive-wipe',
    pattern: /\brm\s+-rf\s+(\/|\/\*|~|\$HOME)\b/i,
  },
  {
    name: 'deny-dd-disk',
    pattern: /\bdd\s+.*\bif=\/dev\//i,
  },
  {
    name: 'deny-mkfs',
    pattern: /\bmkfs(\.|$|\s)/i,
  },
  {
    name: 'deny-disable-auth',
    pattern: /\b(disable[-_ ]?(auth|rbac|admission)|kubectl\s+delete\s+.*\b(clusterrole|rolebinding)\b)/i,
  },
  {
    name: 'deny-secret-exfil',
    pattern: /\b(curl|wget)\b.*\b(secrets?|password|token)\b.*\bhttps?:\/\//i,
  },
  {
    name: 'deny-arbitrary-remote',
    test: (argv) => {
      const bin = (argv[0] || '').split('/').pop()?.toLowerCase();
      if (bin !== 'curl' && bin !== 'wget') return false;
      return extractUrls(argv).some((u) => !isAllowedRemote(u));
    },
  },
  {
    name: 'deny-client-override-flags',
    test: (argv) =>
      (argv[0] === 'kubectl' || argv[0] === 'helm') && DENIED_CLIENT_FLAGS.some((f) => hasFlag(argv, f)),
  },
  {
    name: 'deny-drop-database',
    pattern: /\b(drop\s+(database|schema)|DROP\s+DATABASE)\b/,
  },
  {
    name: 'deny-fork-bomb',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  },
];

const KUBECTL_READ_SUBCOMMANDS = new Set(['get', 'describe', 'top', 'api-resources', 'api-versions', 'version', 'cluster-info']);

/** Output formats that print object bodies (and therefore secret values). */
function kubectlPrintsObjectBodies(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let format: string | null = null;
    if (a === '-o' || a === '--output') format = argv[i + 1] ?? '';
    else if (a.startsWith('--output=')) format = a.slice('--output='.length);
    else if (a.startsWith('-o=')) format = a.slice(3);
    else if (a.startsWith('-o') && !a.startsWith('--') && a.length > 2) format = a.slice(2);
    else if (a === '--template' || a.startsWith('--template=')) return true;
    if (format !== null) {
      const f = format.toLowerCase();
      if (f !== 'wide' && f !== 'name') return true;
    }
  }
  return false;
}

function kubectlTargetsSecrets(argv: string[]): boolean {
  return argv.slice(2).some((a) => {
    if (a.startsWith('-')) return false;
    return a.split(',').some((r) => /^secrets?(\/|\.|$)/i.test(r));
  });
}

/** `kubectl get secret(s) -o yaml|json|jsonpath|...`, `kubectl get --raw`, `cluster-info dump`. */
function isSensitiveKubectlRead(argv: string[]): boolean {
  if (argv[0] !== 'kubectl') return false;
  if (argv[1] === 'get' && hasFlag(argv, '--raw')) return true;
  if (argv[1] === 'get' && kubectlTargetsSecrets(argv) && kubectlPrintsObjectBodies(argv)) return true;
  if (argv[1] === 'cluster-info' && argv[2] === 'dump') return true;
  return false;
}

/**
 * Fixed system commands with tightly-scoped arguments. Deliberately excludes anything that can
 * read arbitrary files (cat, head, tail, wc, ls) or launch other programs / dump the environment
 * (env, printenv, xargs, nice, timeout, ...).
 */
const SYSTEM_READONLY: Record<string, RegExp | null> = {
  uname: /^(-[asnrvmpio]+|--all)$/,
  hostname: null,
  uptime: /^(-p|--pretty)$/,
  df: /^-[hHTikl]+$/,
  free: /^-[hmgkbtw]+$/,
  ps: /^(aux|-ef|-e|-A|-f|-ely)$/,
  whoami: null,
  id: null,
  date: /^(-u|--utc|-I|--iso-8601)$/,
  pwd: null,
};

function matchSystemReadonly(argv: string[]): boolean {
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_READONLY, argv[0])) return false;
  const allowedArg = SYSTEM_READONLY[argv[0]];
  const args = argv.slice(1);
  if (args.length === 0) return true;
  if (!allowedArg) return false;
  return args.every((a) => allowedArg.test(a));
}

const sub = (bin: string, subs: string[]) => (argv: string[]) => argv[0] === bin && subs.includes(argv[1]);

const ALLOW_RULES: AllowRule[] = [
  // Sensitive reads — print secret material, so a human must approve.
  {
    name: 'kubectl-read-sensitive',
    riskLevel: 'read',
    match: isSensitiveKubectlRead,
    requiresReason: true,
    requiresHumanApproval: true,
  },
  {
    name: 'helm-get-values',
    riskLevel: 'read',
    match: sub('helm', ['get']),
    requiresReason: true,
    requiresHumanApproval: true,
  },

  // Read-only
  { name: 'kubectl-get', riskLevel: 'read', match: (argv) => argv[0] === 'kubectl' && KUBECTL_READ_SUBCOMMANDS.has(argv[1]) },
  { name: 'kubectl-logs', riskLevel: 'read', match: sub('kubectl', ['logs']) },
  { name: 'kubectl-explain', riskLevel: 'read', match: sub('kubectl', ['explain']) },
  { name: 'kubectl-rollout-status', riskLevel: 'read', match: (argv) => argv[0] === 'kubectl' && argv[1] === 'rollout' && argv[2] === 'status' },
  { name: 'helm-status', riskLevel: 'read', match: sub('helm', ['status', 'list', 'ls', 'history', 'show']) },
  { name: 'platformctl-status', riskLevel: 'read', match: sub('platformctl', ['status', 'version', 'info', 'health']) },
  { name: 'system-readonly', riskLevel: 'read', match: matchSystemReadonly },

  // Mutating (confirm + reason, no approval)
  {
    name: 'kubectl-rollout',
    riskLevel: 'mutating',
    match: (argv) => argv[0] === 'kubectl' && argv[1] === 'rollout' && ['restart', 'undo', 'pause', 'resume'].includes(argv[2]),
    requiresReason: true,
  },
  {
    name: 'kubectl-annotate-label',
    riskLevel: 'mutating',
    match: sub('kubectl', ['annotate', 'label']),
    requiresReason: true,
  },

  // Mutating — human approval required
  {
    name: 'kubectl-apply',
    riskLevel: 'mutating',
    match: sub('kubectl', ['apply', 'create', 'patch', 'edit', 'scale']),
    requiresReason: true,
    requiresHumanApproval: true,
  },
  {
    name: 'helm-upgrade',
    riskLevel: 'mutating',
    match: sub('helm', ['upgrade', 'install', 'rollback']),
    requiresReason: true,
    requiresHumanApproval: true,
  },

  // Destructive (human approval)
  {
    name: 'kubectl-delete',
    riskLevel: 'destructive',
    match: sub('kubectl', ['delete']),
    requiresReason: true,
  },
  {
    name: 'kubectl-drain',
    riskLevel: 'destructive',
    match: sub('kubectl', ['drain', 'cordon', 'uncordon']),
    requiresReason: true,
  },
  {
    name: 'helm-uninstall',
    riskLevel: 'destructive',
    match: sub('helm', ['uninstall', 'delete']),
    requiresReason: true,
  },
  {
    name: 'platformctl-destroy',
    riskLevel: 'destructive',
    match: sub('platformctl', ['destroy', 'teardown', 'reset']),
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

/** Minimal POSIX-ish argv splitter (no shell expansion). Shared with command-exec so we validate exactly what runs. */
export function splitArgv(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

function denied(matchedPolicy: string, message: string, normalizedCommand: string): CommandValidationResult {
  return {
    allowed: false,
    riskLevel: 'denied',
    matchedPolicy,
    requiresConfirm: false,
    requiresHumanApproval: false,
    requiresReason: false,
    message,
    normalizedCommand,
  };
}

export function validateCommand(command: string): CommandValidationResult {
  const normalizedCommand = normalizeCommand(command);

  if (!normalizedCommand) {
    return denied('empty-command', 'Command must be a non-empty string', normalizedCommand);
  }

  if (
    normalizedCommand.includes('&&') ||
    normalizedCommand.includes(';') ||
    normalizedCommand.includes('|') ||
    normalizedCommand.includes('`') ||
    normalizedCommand.includes('$(')
  ) {
    return denied(
      'deny-shell-chaining',
      'Shell chaining / piping / substitution is not allowed. Submit a single allowlisted command.',
      normalizedCommand,
    );
  }

  const argv = splitArgv(normalizedCommand);

  for (const rule of DENIED_RULES) {
    const hit = (rule.pattern && rule.pattern.test(normalizedCommand)) || (rule.test && rule.test(argv, normalizedCommand));
    if (hit) {
      return denied(rule.name, `Command denied by policy: ${rule.name}`, normalizedCommand);
    }
  }

  for (const rule of ALLOW_RULES) {
    if (rule.match(argv)) {
      const requiresHumanApproval = rule.riskLevel === 'destructive' || Boolean(rule.requiresHumanApproval);
      const requiresConfirm = rule.riskLevel !== 'read' || requiresHumanApproval;
      const requiresReason = Boolean(rule.requiresReason) || requiresHumanApproval;
      return {
        allowed: true,
        riskLevel: rule.riskLevel,
        matchedPolicy: rule.name,
        requiresConfirm,
        requiresHumanApproval,
        requiresReason,
        message: requiresHumanApproval
          ? 'Command requires human approval (approvalId) plus confirm=true and a reason before execute.'
          : rule.riskLevel === 'read'
            ? 'Read-only command; may execute with agent token.'
            : 'Mutating command; requires confirm=true and a reason.',
        normalizedCommand,
      };
    }
  }

  return denied('no-matching-policy', 'Command does not match any allowlisted policy', normalizedCommand);
}
