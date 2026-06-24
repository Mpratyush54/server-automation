import { LoggerClient } from './logger';

// ──── Winston Transport ───────────────────────────────────────────────────────
// Returns a Winston-compatible transport object
export function createWinstonTransport(logger: LoggerClient) {
  // Winston transports extend EventEmitter and require log() method
  return {
    name: 'caps-platform',
    level: 'debug',
    log(info: any, callback: Function) {
      const level = (info.level || 'info').toUpperCase();
      const message = info.message;
      const metadata = { ...info };
      delete metadata.message;
      delete metadata.level;

      switch (level) {
        case 'ERROR': logger.error(message, metadata); break;
        case 'WARN': logger.warn(message, metadata); break;
        case 'DEBUG': logger.debug(message, metadata); break;
        default: logger.info(message, metadata);
      }
      if (callback) callback();
    },
  };
}

// ──── Pino Transport ──────────────────────────────────────────────────────────
// Returns a Pino-compatible destination stream
export function createPinoTransport(logger: LoggerClient) {
  return {
    write(chunk: string) {
      try {
        const entry = JSON.parse(chunk);
        const level = entry.level >= 50 ? 'ERROR' : entry.level >= 40 ? 'WARN' : entry.level >= 30 ? 'INFO' : 'DEBUG';
        const msg = entry.msg || entry.message || '';
        const metadata = { ...entry };
        delete metadata.msg;
        delete metadata.message;
        delete metadata.level;
        delete metadata.time;

        switch (level) {
          case 'ERROR': logger.error(msg, metadata); break;
          case 'WARN': logger.warn(msg, metadata); break;
          case 'DEBUG': logger.debug(msg, metadata); break;
          default: logger.info(msg, metadata);
        }
      } catch {}
    },
  };
}
