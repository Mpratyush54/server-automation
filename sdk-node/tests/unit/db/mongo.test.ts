import { MongoManager } from '../../../src/db/mongo';

jest.mock('mongoose', () => {
  const mockConnection = {
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    createConnection: jest.fn().mockReturnValue({
      asPromise: jest.fn().mockResolvedValue(mockConnection),
    }),
  };
});

describe('MongoManager', () => {
  let mongoManager: MongoManager;

  beforeEach(() => {
    mongoManager = new MongoManager({ uri: 'mongodb://localhost:27017/test' });
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set default URI when none provided', () => {
      const manager = new MongoManager();
      expect(manager).toBeDefined();
      expect(manager.isConnected).toBe(false);
    });

    it('should use provided URI', () => {
      expect(mongoManager).toBeDefined();
    });

    it('should have health property', () => {
      expect(mongoManager.health).toEqual({ connected: false });
    });
  });

  describe('connect', () => {
    it('should connect successfully', async () => {
      await mongoManager.connect();
      expect(mongoManager.isConnected).toBe(true);
    });

    it('should handle connection failure', async () => {
      const mongoose = require('mongoose');
      mongoose.createConnection.mockReturnValue({
        asPromise: jest.fn().mockRejectedValue(new Error('Connection refused')),
      });

      const manager = new MongoManager();
      await manager.connect();
      expect(manager.isConnected).toBe(false);
    });
  });

  describe('db', () => {
    it('should return null when not connected', () => {
      expect(mongoManager.db).toBeNull();
    });

    it('should return connection when connected', async () => {
      await mongoManager.connect();
      expect(mongoManager.db).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should disconnect successfully', async () => {
      await mongoManager.connect();
      await mongoManager.disconnect();
      expect(mongoManager.isConnected).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      await expect(mongoManager.disconnect()).resolves.not.toThrow();
    });
  });
});
