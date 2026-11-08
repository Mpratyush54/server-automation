/**
 * Issue #18: graceful shutdown drains in-flight requests before closing resources.
 */
import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { drainingConnectionClose, gracefulShutdown, isShuttingDown, resetShutdownStateForTests } from '../../../src/lib/shutdown';

function get(port: number, path: string): Promise<{ status: number; body: string; connection?: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body, connection: res.headers.connection as string }));
    }).on('error', reject);
  });
}

afterEach(() => resetShutdownStateForTests());

it('finishes in-flight requests, refuses new connections, then runs closers and exits 0', async () => {
  const app = express();
  app.use(drainingConnectionClose);
  app.get('/slow', (_req, res) => setTimeout(() => res.send('done'), 150));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;

  const inflight = get(port, '/slow');
  await new Promise((r) => setTimeout(r, 30));

  const order: string[] = [];
  const exit = jest.fn();
  const done = gracefulShutdown(server, {
    timeoutMs: 2000,
    log: () => {},
    exit,
    closers: [
      { name: 'redis', close: async () => { order.push('redis'); } },
      { name: 'postgres', close: async () => { order.push('postgres'); throw new Error('already closed'); } },
      { name: 'mongo', close: () => { order.push('mongo'); } },
    ],
  });
  expect(isShuttingDown()).toBe(true);

  const res = await inflight;
  expect(res.status).toBe(200);
  expect(res.body).toBe('done');
  expect(res.connection).toBe('close');

  await done;
  expect(order).toEqual(['redis', 'postgres', 'mongo']); // a failing closer does not stop the rest
  expect(exit).toHaveBeenCalledWith(0);
  await expect(get(port, '/slow')).rejects.toThrow();
});

it('force-closes connections after the deadline', async () => {
  const app = express();
  app.get('/hang', () => { /* never responds */ });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const hung = get(port, '/hang').catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  const exit = jest.fn();
  const started = Date.now();
  await gracefulShutdown(server, { timeoutMs: 100, log: () => {}, exit });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(exit).toHaveBeenCalledWith(0);
  // The hung client sees its socket closed (an error object from another realm under Jest).
  expect(String(await hung)).toMatch(/socket hang up|ECONNRESET/i);
});
