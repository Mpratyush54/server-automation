import { LoggerClient } from '../../src/logger';
import { captureConsole } from '../../src/console-capture';

describe('captureConsole + LoggerClient', () => {
  let logger: LoggerClient;
  let mockHttp: any;
  let restore: () => void;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origDebug = console.debug;

  beforeEach(() => {
    // Silence real output; captureConsole wraps whatever console.* is at install time.
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
    console.debug = jest.fn();
    mockHttp = { post: jest.fn().mockResolvedValue({ status: 204 }) };
    logger = new LoggerClient();
    logger.configure(mockHttp, 'test-project', 'development', 'svc');
    restore = captureConsole(logger);
  });

  afterEach(() => {
    restore();
    logger.stop();
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    console.debug = origDebug;
  });

  it('console.log enqueues exactly one entry and does not recurse', () => {
    console.log('Application started');
    expect(logger.pending).toBe(1);
  });

  it('logger.info while capture is active enqueues exactly one entry', () => {
    logger.info('hello');
    expect(logger.pending).toBe(1);
  });

  it('each console level enqueues one entry with the right level', async () => {
    console.log('a');
    console.warn('b');
    console.error('c');
    console.debug('d');
    expect(logger.pending).toBe(4);
    logger.stop();
    await new Promise((r) => setImmediate(r));
    const logs = mockHttp.post.mock.calls[0][1].logs;
    expect(logs.map((l: any) => l.level)).toEqual(['INFO', 'WARN', 'ERROR', 'DEBUG']);
    expect(logs[0].message).toBe('a');
  });

  it('still prints through the original console function', () => {
    const inner = (console.log as any);
    restore();
    const spy = jest.fn();
    console.log = spy;
    restore = captureConsole(logger);
    console.log('x', 1);
    expect(spy).toHaveBeenCalledWith('x', 1);
    expect(inner).toBeDefined();
  });

  it('is idempotent: a second captureConsole does not double-forward', () => {
    const again = captureConsole(logger);
    console.log('once');
    expect(logger.pending).toBe(1);
    expect(again).toBe(restore);
  });

  it('restore() puts the original console methods back', () => {
    const before = console.log;
    restore();
    expect(console.log).not.toBe(before);
    console.log('not captured');
    expect(logger.pending).toBe(0);
  });
});
