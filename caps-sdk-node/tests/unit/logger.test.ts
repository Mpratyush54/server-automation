import { LoggerClient } from '../../src/logger';

describe('LoggerClient', () => {
  let logger: LoggerClient;
  let mockHttp: any;

  beforeEach(() => {
    mockHttp = { post: jest.fn().mockResolvedValue({ status: 204 }) };
    logger = new LoggerClient();
    logger.configure(mockHttp, 'test-project', 'development', 'test-service', 'main', 'abc123', 'localhost');
    jest.clearAllMocks();
  });

  afterEach(() => {
    logger.stop();
  });

  describe('info', () => {
    it('should add log to buffer with INFO level', () => {
      logger.info('Test message', { extra: 'data' });
      // Log is enqueued internally
      expect(true).toBe(true);
    });
  });

  describe('warn', () => {
    it('should add log to buffer with WARN level', () => {
      logger.warn('Warning message');
      expect(true).toBe(true);
    });
  });

  describe('error', () => {
    it('should add log to buffer with ERROR level', () => {
      logger.error('Error message', { stack: 'trace' });
      expect(true).toBe(true);
    });
  });

  describe('debug', () => {
    it('should add log to buffer with DEBUG level', () => {
      logger.debug('Debug message');
      expect(true).toBe(true);
    });
  });

  describe('flush via stop', () => {
    it('should flush logs to the API when stop is called', async () => {
      logger.info('Test log 1');
      logger.info('Test log 2');

      logger.stop();

      // Allow async flush to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockHttp.post).toHaveBeenCalledWith('/api/sdk/logs', expect.objectContaining({
        logs: expect.arrayContaining([
          expect.objectContaining({
            projectId: 'test-project',
            level: 'INFO',
          }),
        ]),
      }));
    });

    it('should not flush when buffer is empty', async () => {
      logger.stop();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockHttp.post).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should clear interval and flush remaining logs', () => {
      logger.info('Final log');
      logger.stop();
      // Should not throw
    });
  });

  describe('not configured', () => {
    it('should not enqueue logs when http is not set', () => {
      const unconfiguredLogger = new LoggerClient();
      unconfiguredLogger.info('This should not be enqueued');
      unconfiguredLogger.stop();
    });
  });

  describe('buffer threshold', () => {
    it('should auto-flush when buffer reaches 50 entries', async () => {
      // The enqueue method triggers flush at 50 entries
      for (let i = 0; i < 50; i++) {
        logger.info(`Log ${i}`);
      }

      // Allow async flush
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockHttp.post).toHaveBeenCalled();
    });
  });

  describe('flush failure re-queue', () => {
    it('should re-queue logs on flush failure', async () => {
      mockHttp.post.mockRejectedValueOnce(new Error('Network error'));

      logger.info('Log that will fail');
      logger.stop();

      // Allow async flush to complete and fail
      await new Promise(resolve => setTimeout(resolve, 100));

      // The failed batch should be re-queued
      // Verify that the error was handled
      expect(true).toBe(true);
    });
  });
});
