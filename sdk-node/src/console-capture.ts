type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface CaptureTarget {
  info: Function;
  warn: Function;
  error: Function;
  debug: Function;
  /** Optional: enqueue an entry without echoing it to the console (LoggerClient implements this). */
  record?: (level: LogLevel, message: string, metadata?: any) => void;
}

// Re-entrancy guard. While > 0, patched console methods only print and never forward
// to the Platform logger. Prevents console.log -> logger.info -> console.log -> ... loops.
let suppressDepth = 0;
let restoreActive: (() => void) | null = null;

/** Run fn with console capture suspended (used for the SDK's own console output). */
export function runWithoutCapture<T>(fn: () => T): T {
  suppressDepth++;
  try {
    return fn();
  } finally {
    suppressDepth--;
  }
}

// Patches console.log/warn/error/debug to also route through Platform logger.
// Returns a function that restores the original console methods.
export function captureConsole(logger: CaptureTarget): () => void {
  // Idempotent: patching twice would forward every line twice.
  if (restoreActive) return restoreActive;

  const saved = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const wrap = (
    original: (...args: any[]) => void,
    level: LogLevel,
    method: 'info' | 'warn' | 'error' | 'debug'
  ) => (...args: any[]) => {
    original.apply(console, args);
    if (suppressDepth > 0) return;
    runWithoutCapture(() => {
      try {
        const message = args.map(formatArg).join(' ');
        if (typeof logger.record === 'function') logger.record(level, message);
        else logger[method](message);
      } catch {}
    });
  };

  console.log = wrap(saved.log, 'INFO', 'info');
  console.warn = wrap(saved.warn, 'WARN', 'warn');
  console.error = wrap(saved.error, 'ERROR', 'error');
  console.debug = wrap(saved.debug, 'DEBUG', 'debug');

  const restore = () => {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    console.debug = saved.debug;
    if (restoreActive === restore) restoreActive = null;
  };
  restoreActive = restore;
  return restore;
}

function formatArg(arg: any): string {
  if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  return String(arg);
}
