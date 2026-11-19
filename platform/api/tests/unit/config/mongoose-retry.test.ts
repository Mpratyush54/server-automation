jest.mock('mongoose', () => ({ __esModule: true, default: { connect: jest.fn() } }));
import mongoose from 'mongoose';
import { connectMongo } from '../../../src/config/mongoose';

// mongoose never retries a failed initial connect: connectMongo must not cache
// the rejection, or one failed start-up connect breaks Mongo for the pod's life.
it('retries after a failed first connect and then reuses the connection', async () => {
  const connect = mongoose.connect as jest.Mock;
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND mongodb-1.mongodb-headless'), { code: 'ENOTFOUND' });
  const conn = { readyState: 1 };
  connect.mockRejectedValueOnce(dns).mockResolvedValueOnce(conn);

  await expect(connectMongo()).rejects.toThrow('ENOTFOUND');
  await expect(connectMongo()).resolves.toBe(conn);
  await expect(connectMongo()).resolves.toBe(conn);
  expect(connect).toHaveBeenCalledTimes(2);
});
