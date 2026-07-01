jest.mock('pg', () => {
  const mockQuery = jest.fn().mockResolvedValue({ rows: [{ result: 1 }] });
  const mockConnect = jest.fn().mockResolvedValue({ release: jest.fn() });
  const mockEnd = jest.fn().mockResolvedValue(undefined);
  const MockPool = jest.fn(() => ({ query: mockQuery, connect: mockConnect, end: mockEnd }));
  return { Pool: MockPool };
});

import { PostgresManager } from '../../../src/db/postgres';

describe('PostgresManager', () => {
  let pgManager: PostgresManager;

  beforeEach(() => {
    jest.clearAllMocks();
    pgManager = new PostgresManager({
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'test',
      database: 'test_db',
    });
  });

  describe('constructor', () => {
    it('should set default config when none provided', () => {
      const manager = new PostgresManager();
      expect(manager).toBeDefined();
      expect(manager.isConnected).toBe(false);
    });

    it('should have health property', () => {
      expect(pgManager.health).toEqual({ connected: false, poolSize: 10 });
    });
  });

  describe('connect', () => {
    it('should connect successfully', async () => {
      await pgManager.connect();
      expect(pgManager.isConnected).toBe(true);
    });

    it('should handle connection failure', async () => {
      const { Pool } = require('pg');
      Pool.mockReturnValueOnce({
        query: jest.fn().mockRejectedValue(new Error('Connection refused')),
        connect: jest.fn(),
        end: jest.fn(),
      });

      const manager = new PostgresManager();
      await manager.connect();
      expect(manager.isConnected).toBe(false);
    });
  });

  describe('query', () => {
    it('should execute query when connected', async () => {
      await pgManager.connect();
      const result = await pgManager.query('SELECT 1');
      expect(result).toBeDefined();
      expect(result.rows).toEqual([{ result: 1 }]);
    });

    it('should throw when not connected', async () => {
      await expect(pgManager.query('SELECT 1')).rejects.toThrow('PostgreSQL not connected');
    });
  });

  describe('getClient', () => {
    it('should return a pool client when connected', async () => {
      await pgManager.connect();
      const client = await pgManager.getClient();
      expect(client).toBeDefined();
      expect(client.release).toBeDefined();
    });

    it('should throw when not connected', async () => {
      await expect(pgManager.getClient()).rejects.toThrow('PostgreSQL not connected');
    });
  });

  describe('disconnect', () => {
    it('should disconnect successfully', async () => {
      await pgManager.connect();
      await pgManager.disconnect();
      expect(pgManager.isConnected).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      await expect(pgManager.disconnect()).resolves.not.toThrow();
    });
  });
});
