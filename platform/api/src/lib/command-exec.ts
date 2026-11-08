import { execFile } from 'child_process';
import { promisify } from 'util';
import { validateCommand, CommandValidationResult, splitArgv } from './command-guard';

export { splitArgv };

const execFileAsync = promisify(execFile);

export interface CommandExecOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Extra variables for the child. Only keys in CHILD_ENV_ALLOWLIST are honoured. */
  env?: NodeJS.ProcessEnv;
  /** When true, skip spawning and return a dry-run result (used in tests). */
  dryRun?: boolean;
}

export interface CommandExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  validation: CommandValidationResult;
  dryRun?: boolean;
  error?: string;
}

/**
 * Environment variables a guarded child process may see. The API's own environment holds
 * JWT/DB/encryption secrets, so it is never inherited wholesale.
 */
// KUBERNETES_SERVICE_HOST/PORT are non-secret and required for kubectl's in-cluster config.
export const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'KUBECONFIG', 'KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT'] as const;

export function buildChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = extra[key] ?? process.env[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return env;
}

/**
 * Execute a previously validated shell command safely.
 * Uses execFile with shell:false and argv splitting — no shell metacharacters.
 */
export async function executeValidatedCommand(
  command: string,
  options: CommandExecOptions = {},
): Promise<CommandExecResult> {
  const validation = validateCommand(command);
  const started = Date.now();

  if (!validation.allowed) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      validation,
      error: validation.message,
    };
  }

  if (options.dryRun || process.env.AGENT_COMMAND_DRY_RUN === '1') {
    return {
      ok: true,
      exitCode: 0,
      stdout: `[dry-run] ${validation.normalizedCommand}`,
      stderr: '',
      durationMs: Date.now() - started,
      validation,
      dryRun: true,
    };
  }

  const parts = splitArgv(validation.normalizedCommand);
  if (parts.length === 0) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      validation,
      error: 'Unable to parse command argv',
    };
  }

  const [bin, ...args] = parts;
  const timeoutMs = options.timeoutMs ?? 60_000;

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      cwd: options.cwd,
      env: buildChildEnv(options.env || {}),
      shell: false,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      durationMs: Date.now() - started,
      validation,
    };
  } catch (err: any) {
    return {
      ok: false,
      exitCode: typeof err?.code === 'number' ? err.code : null,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || ''),
      durationMs: Date.now() - started,
      validation,
      error: err?.killed ? 'Command timed out' : (err?.message || 'Command failed'),
    };
  }
}
