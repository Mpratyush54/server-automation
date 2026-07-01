// Patches console.log/warn/error to also route through Platform logger
export function captureConsole(logger: { info: Function; warn: Function; error: Function; debug: Function }) {
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalDebug = console.debug.bind(console);

  console.log = (...args: any[]) => {
    originalLog(...args);
    try { logger.info(args.map(formatArg).join(' ')); } catch {}
  };

  console.warn = (...args: any[]) => {
    originalWarn(...args);
    try { logger.warn(args.map(formatArg).join(' ')); } catch {}
  };

  console.error = (...args: any[]) => {
    originalError(...args);
    try { logger.error(args.map(formatArg).join(' ')); } catch {}
  };

  console.debug = (...args: any[]) => {
    originalDebug(...args);
    try { logger.debug(args.map(formatArg).join(' ')); } catch {}
  };
}

function formatArg(arg: any): string {
  if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  return String(arg);
}
