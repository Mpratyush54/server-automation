import { execFile } from 'child_process';
import { promisify } from 'util';
import { validateCommand, CommandValidationResult } from './command-guard';

const execFileAsync = promisify(execFile);

export interface CommandExecOptions {
  timeoutMs?: number;
  cwd?: string;
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
      env: { ...process.env, ...(options.env || {}) },
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

/** Minimal POSIX-ish argv splitter (no shell expansion). */
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
