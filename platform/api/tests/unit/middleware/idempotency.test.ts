/**
 * Idempotency-Key middleware: replay, body mismatch (422), in-flight (409), non-cacheable
 * responses, per-user scoping, and encrypted storage.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "idempotency-test-secret";

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({ getRepository: () => ({}) }),
}));

import express from 'express';
import request from 'supertest';
import { idempotency, MemoryIdempotencyStore, setIdempotencyStore } from '../../../src/middleware/idempotency';
import { setCoordinationRedisForTests } from '../../../src/lib/coord-redis';

let executions = 0;
let gate: Promise<void> | null = null;
let nextStatus = 201;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as any).user = { id: String(req.header('x-user') || 'u1'), role: 'devops' };
    next();
  });
  a.post('/things/:id', idempotency('POST /things/:id'), async (req, res) => {
    executions++;
    if (gate) await gate;
    res.status(nextStatus).json({ n: executions, id: req.params.id, body: req.body, secret: 'pw-123' });
  });
  return a;
}

let store: MemoryIdempotencyStore;
beforeEach(() => {
  executions = 0;
  gate = null;
  nextStatus = 201;
  store = new MemoryIdempotencyStore();
  setIdempotencyStore(store);
  setCoordinationRedisForTests(null);
});

it('passes through when no Idempotency-Key is sent', async () => {
  await request(app()).post('/things/1').send({ a: 1 }).expect(201);
  await request(app()).post('/things/1').send({ a: 1 }).expect(201);
  expect(executions).toBe(2);
});

it('replays the identical response for the same key without re-executing', async () => {
  const a = app();
  const first = await request(a).post('/things/1').set('Idempotency-Key', 'key-1').send({ a: 1, b: [1, 2] });
  const second = await request(a).post('/things/1').set('Idempotency-Key', 'key-1').send({ b: [1, 2], a: 1 });
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body).toEqual(first.body);
  expect(second.headers['idempotent-replayed']).toBe('true');
  expect(executions).toBe(1);
});

it('rejects the same key with a different body (422)', async () => {
  const a = app();
  await request(a).post('/things/1').set('Idempotency-Key', 'key-2').send({ a: 1 }).expect(201);
  const r = await request(a).post('/things/1').set('Idempotency-Key', 'key-2').send({ a: 2 });
  expect(r.status).toBe(422);
  expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  // different path params count as a different request too
  await request(a).post('/things/2').set('Idempotency-Key', 'key-2').send({ a: 1 }).expect(422);
  expect(executions).toBe(1);
});

it('returns 409 while the first request with the key is still running', async () => {
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  const a = app();
  const first = request(a).post('/things/1').set('Idempotency-Key', 'key-3').send({ a: 1 }).then((r) => r);
  await new Promise((r) => setTimeout(r, 50));
  const second = await request(a).post('/things/1').set('Idempotency-Key', 'key-3').send({ a: 1 });
  expect(second.status).toBe(409);
  expect(second.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  open();
  expect((await first).status).toBe(201);
  const third = await request(a).post('/things/1').set('Idempotency-Key', 'key-3').send({ a: 1 });
  expect(third.headers['idempotent-replayed']).toBe('true');
  expect(executions).toBe(1);
});

it.each([500, 503, 409, 429])('does not store a %s response, so the client may retry', async (status) => {
  const a = app();
  nextStatus = status;
  await request(a).post('/things/1').set('Idempotency-Key', `k-${status}`).send({}).expect(status);
  nextStatus = 201;
  const retry = await request(a).post('/things/1').set('Idempotency-Key', `k-${status}`).send({});
  expect(retry.status).toBe(201);
  expect(retry.headers['idempotent-replayed']).toBeUndefined();
  expect(executions).toBe(2);
});

it('scopes keys per user', async () => {
  const a = app();
  await request(a).post('/things/1').set('x-user', 'alice').set('Idempotency-Key', 'shared').send({}).expect(201);
  const bob = await request(a).post('/things/1').set('x-user', 'bob').set('Idempotency-Key', 'shared').send({});
  expect(bob.headers['idempotent-replayed']).toBeUndefined();
  expect(executions).toBe(2);
});

it('rejects malformed keys', async () => {
  await request(app()).post('/things/1').set('Idempotency-Key', 'x'.repeat(300)).send({}).expect(400);
  expect(executions).toBe(0);
});

it('stores response bodies encrypted (they can carry one-time credentials)', async () => {
  const a = app();
  await request(a).post('/things/1').set('Idempotency-Key', 'enc').send({}).expect(201);
  const raw = JSON.stringify((store as any).m.values().next().value);
  expect(raw).not.toContain('pw-123');
  expect(raw).toContain('enc:');
});
