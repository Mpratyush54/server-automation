import crypto from 'crypto';
import type { OperationStatus } from '../entities/Operation';
import type { OperationStepStatus } from '../entities/OperationStep';
import type { OutboxStatus } from '../entities/OutboxMessage';
import { encryptValue, decryptValue } from './secrets-encryption';
import { coordinationEncryptionKey } from './stable-hash';

export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set(['succeeded', 'failed', 'compensated']);

export interface StepRecord {
  index: number;
  name: string;
  status: OperationStepStatus;
  attempts: number;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface OperationRecord {
  id: string;
  type: string;
  projectId: string | null;
  lockKey: string | null;
  lockFence: string | null;
  status: OperationStatus;
  currentStep: number;
  inputHash: string;
  input: Record<string, unknown> | null;
  /** Working state (decrypted in memory). */
  state: Record<string, unknown>;
  /** When true the state is encrypted at rest and wiped once the operation is terminal. */
  sensitive: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  steps: StepRecord[];
}

export interface OutboxDraft {
  kind: string;
  payload: Record<string, unknown>;
}

export interface OutboxRecord extends OutboxDraft {
  id: string;
  operationId: string | null;
  status: OutboxStatus;
  attempts: number;
  availableAt: Date;
  lastError: string | null;
}

export interface OperationListFilter {
  projectId?: string;
  type?: string;
  limit?: number;
}

/** Raised when a write is rejected because another runner (newer fence) owns the operation. */
export class FencedError extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} is owned by another runner`);
    this.name = 'FencedError';
  }
}

export interface OperationStore {
  /** False for the in-memory fallback (progress is lost on restart). */
  readonly durable: boolean;
  create(rec: OperationRecord): Promise<void>;
  get(id: string): Promise<OperationRecord | null>;
  /** Take ownership for a run: set the fence and increment attempts. */
  claim(id: string, fence: string): Promise<OperationRecord | null>;
  /** Persist progress (+ outbox messages atomically). Throws FencedError for a stale fence. */
  save(rec: OperationRecord, fence: string, outbox?: OutboxDraft[]): Promise<void>;
  listNonTerminal(): Promise<OperationRecord[]>;
  list(filter: OperationListFilter): Promise<OperationRecord[]>;
  activeIdByLockKey(lockKey: string): Promise<string | null>;
  enqueueOutbox(operationId: string | null, msgs: OutboxDraft[]): Promise<void>;
  /** Claim up to `limit` due messages (visibility timeout 5 min). */
  claimOutbox(limit: number, operationId?: string): Promise<OutboxRecord[]>;
  completeOutbox(id: string, ok: boolean, error?: string, retryAt?: Date | null): Promise<void>;
  /** Retention: drop sent outbox rows and expired coordination rows. */
  cleanup(now?: Date): Promise<void>;
}

const OUTBOX_VISIBILITY_MS = 5 * 60_000;
const OUTBOX_RETENTION_MS = 7 * 24 * 3600_000;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v), (_k, val) =>
    typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(val) ? new Date(val) : val);
}

// ── in-memory store (tests, or when Postgres is unusable) ─────────────────────
export class MemoryOperationStore implements OperationStore {
  readonly durable = false;
  private ops = new Map<string, OperationRecord>();
  private outbox = new Map<string, OutboxRecord & { createdAt: number; sentAt: number | null }>();

  async create(rec: OperationRecord): Promise<void> {
    if (this.ops.has(rec.id)) throw new Error(`operation ${rec.id} already exists`);
    this.ops.set(rec.id, clone(rec));
  }

  async get(id: string): Promise<OperationRecord | null> {
    const r = this.ops.get(id);
    return r ? clone(r) : null;
  }

  async claim(id: string, fence: string): Promise<OperationRecord | null> {
    const r = this.ops.get(id);
    if (!r) return null;
    r.lockFence = fence;
    r.attempts += 1;
    r.updatedAt = new Date();
    return clone(r);
  }

  async save(rec: OperationRecord, fence: string, outbox: OutboxDraft[] = []): Promise<void> {
    const cur = this.ops.get(rec.id);
    if (!cur || cur.lockFence !== fence) throw new FencedError(rec.id);
    const next = clone({ ...rec, lockFence: fence, updatedAt: new Date() });
    if (next.sensitive && TERMINAL_STATUSES.has(next.status)) next.state = {};
    this.ops.set(rec.id, next);
    await this.enqueueOutbox(rec.id, outbox);
  }

  async listNonTerminal(): Promise<OperationRecord[]> {
    return [...this.ops.values()].filter((r) => !TERMINAL_STATUSES.has(r.status)).map(clone);
  }

  async list(filter: OperationListFilter): Promise<OperationRecord[]> {
    return [...this.ops.values()]
      .filter((r) => (!filter.projectId || r.projectId === filter.projectId) && (!filter.type || r.type === filter.type))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit || 20)
      .map(clone);
  }

  async activeIdByLockKey(lockKey: string): Promise<string | null> {
    const r = [...this.ops.values()].find((o) => o.lockKey === lockKey && !TERMINAL_STATUSES.has(o.status));
    return r?.id || null;
  }

  async enqueueOutbox(operationId: string | null, msgs: OutboxDraft[]): Promise<void> {
    for (const m of msgs) {
      const id = crypto.randomUUID();
      this.outbox.set(id, {
        id, operationId, kind: m.kind, payload: clone(m.payload), status: 'pending', attempts: 0,
        availableAt: new Date(), lastError: null, createdAt: Date.now(), sentAt: null,
      });
    }
  }

  async claimOutbox(limit: number, operationId?: string): Promise<OutboxRecord[]> {
    const now = Date.now();
    const due = [...this.outbox.values()]
      .filter((m) => (m.status === 'pending' || m.status === 'sending') && m.availableAt.getTime() <= now
        && (!operationId || m.operationId === operationId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    for (const m of due) {
      m.status = 'sending';
      m.attempts += 1;
      m.availableAt = new Date(now + OUTBOX_VISIBILITY_MS);
    }
    return due.map((m) => clone({ ...m }));
  }

  async completeOutbox(id: string, ok: boolean, error?: string, retryAt?: Date | null): Promise<void> {
    const m = this.outbox.get(id);
    if (!m) return;
    if (ok) {
      m.status = 'sent';
      m.sentAt = Date.now();
      m.lastError = null;
    } else {
      m.lastError = error || 'failed';
      if (retryAt) {
        m.status = 'pending';
        m.availableAt = retryAt;
      } else {
        m.status = 'failed';
      }
    }
  }

  async cleanup(now = new Date()): Promise<void> {
    for (const [id, m] of this.outbox) {
      if (m.status === 'sent' && m.sentAt && now.getTime() - m.sentAt > OUTBOX_RETENTION_MS) this.outbox.delete(id);
    }
  }

  /** Test helper. */
  outboxSnapshot(): OutboxRecord[] {
    return [...this.outbox.values()].map((m) => clone({ ...m }));
  }
}

// ── Postgres (TypeORM) store ──────────────────────────────────────────────────
type DsGetter = () => Promise<any>;

function encryptState(state: Record<string, unknown>): string {
  const key = coordinationEncryptionKey();
  if (!key) throw new Error('SECRETS_ENCRYPTION_KEY (or JWT_SECRET) is required to persist sensitive operation state');
  return encryptValue(JSON.stringify(state), key);
}

function decryptState(payload: string): Record<string, unknown> {
  const keys = Array.from(new Set([process.env.SECRETS_ENCRYPTION_KEY, process.env.JWT_SECRET].filter((k): k is string => !!k)));
  for (const k of keys) {
    try { return JSON.parse(decryptValue(payload, k)); } catch {}
  }
  throw new Error('cannot decrypt operation state (encryption key changed?)');
}

export class TypeormOperationStore implements OperationStore {
  readonly durable = true;
  constructor(private readonly getDs: DsGetter) {}

  private async entities() {
    const [{ Operation }, { OperationStep }, { OutboxMessage }] = await Promise.all([
      import('../entities/Operation'),
      import('../entities/OperationStep'),
      import('../entities/OutboxMessage'),
    ]);
    return { Operation, OperationStep, OutboxMessage };
  }

  private toRow(rec: OperationRecord) {
    const terminal = TERMINAL_STATUSES.has(rec.status);
    return {
      id: rec.id,
      type: rec.type,
      projectId: rec.projectId,
      lockKey: rec.lockKey,
      status: rec.status,
      currentStep: rec.currentStep,
      inputHash: rec.inputHash,
      input: rec.input,
      state: rec.sensitive ? null : rec.state,
      stateEncrypted: rec.sensitive && !terminal && Object.keys(rec.state || {}).length ? encryptState(rec.state) : null,
      result: rec.result,
      error: rec.error,
      createdById: rec.createdById,
      finishedAt: rec.finishedAt,
    };
  }

  private fromRow(row: any, steps: any[]): OperationRecord {
    const sensitive = !!row.stateEncrypted || row.state === null;
    let state: Record<string, unknown> = row.state || {};
    if (row.stateEncrypted) state = decryptState(row.stateEncrypted);
    return {
      id: row.id,
      type: row.type,
      projectId: row.projectId ?? null,
      lockKey: row.lockKey ?? null,
      lockFence: row.lockFence ?? null,
      status: row.status,
      currentStep: row.currentStep ?? 0,
      inputHash: row.inputHash,
      input: row.input ?? null,
      state,
      sensitive,
      result: row.result ?? null,
      error: row.error ?? null,
      attempts: row.attempts ?? 0,
      createdById: row.createdById ?? null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
      steps: steps
        .sort((a, b) => a.index - b.index)
        .map((s) => ({
          index: s.index, name: s.name, status: s.status, attempts: s.attempts, output: s.output ?? null,
          error: s.error ?? null, startedAt: s.startedAt ?? null, finishedAt: s.finishedAt ?? null,
        })),
    };
  }

  async create(rec: OperationRecord): Promise<void> {
    const ds = await this.getDs();
    const { Operation, OperationStep } = await this.entities();
    await ds.transaction(async (m: any) => {
      await m.getRepository(Operation).insert({ ...this.toRow(rec), lockFence: rec.lockFence, attempts: rec.attempts });
      if (rec.steps.length) {
        await m.getRepository(OperationStep).insert(rec.steps.map((s) => ({ ...s, operationId: rec.id })));
      }
    });
  }

  async get(id: string): Promise<OperationRecord | null> {
    const ds = await this.getDs();
    const { Operation, OperationStep } = await this.entities();
    const row = await ds.getRepository(Operation).findOne({ where: { id } });
    if (!row) return null;
    const steps = await ds.getRepository(OperationStep).find({ where: { operationId: id } });
    const rec = this.fromRow(row, steps);
    // `sensitive` is not a column: a terminal sensitive op has both state columns null.
    return rec;
  }

  async claim(id: string, fence: string): Promise<OperationRecord | null> {
    const ds = await this.getDs();
    const { Operation } = await this.entities();
    await ds.createQueryBuilder()
      .update(Operation)
      .set({ lockFence: fence, attempts: () => 'attempts + 1' })
      .where('id = :id', { id })
      .execute();
    return this.get(id);
  }

  async save(rec: OperationRecord, fence: string, outbox: OutboxDraft[] = []): Promise<void> {
    const ds = await this.getDs();
    const { Operation, OperationStep, OutboxMessage } = await this.entities();
    const row = this.toRow(rec);
    await ds.transaction(async (m: any) => {
      const { id, ...rest } = row;
      const res = await m.createQueryBuilder()
        .update(Operation)
        .set(rest)
        .where('id = :id AND lock_fence = :fence', { id, fence })
        .execute();
      if (!res.affected) throw new FencedError(rec.id);
      for (const s of rec.steps) {
        await m.getRepository(OperationStep).update(
          { operationId: rec.id, index: s.index },
          { status: s.status, attempts: s.attempts, output: s.output, error: s.error, startedAt: s.startedAt, finishedAt: s.finishedAt },
        );
      }
      if (outbox.length) {
        await m.getRepository(OutboxMessage).insert(outbox.map((o) => ({ operationId: rec.id, kind: o.kind, payload: o.payload })));
      }
    });
  }

  private async findMany(where: Record<string, unknown> | Array<Record<string, unknown>>, limit?: number): Promise<OperationRecord[]> {
    const ds = await this.getDs();
    const { Operation, OperationStep } = await this.entities();
    const rows = await ds.getRepository(Operation).find({ where, order: { createdAt: 'DESC' }, take: limit });
    if (!rows.length) return [];
    const { In } = await import('typeorm');
    const steps = await ds.getRepository(OperationStep).find({ where: { operationId: In(rows.map((r: any) => r.id)) } });
    return rows.map((r: any) => this.fromRow(r, steps.filter((s: any) => s.operationId === r.id)));
  }

  async listNonTerminal(): Promise<OperationRecord[]> {
    const { In } = await import('typeorm');
    return this.findMany({ status: In(['pending', 'running', 'compensating']) }, 200);
  }

  async list(filter: OperationListFilter): Promise<OperationRecord[]> {
    const where: Record<string, unknown> = {};
    if (filter.projectId) where.projectId = filter.projectId;
    if (filter.type) where.type = filter.type;
    return this.findMany(where, Math.min(filter.limit || 20, 100));
  }

  async activeIdByLockKey(lockKey: string): Promise<string | null> {
    const ds = await this.getDs();
    const { Operation } = await this.entities();
    const { In } = await import('typeorm');
    const row = await ds.getRepository(Operation).findOne({
      where: { lockKey, status: In(['pending', 'running', 'compensating']) },
      order: { createdAt: 'DESC' },
    });
    return row?.id || null;
  }

  async enqueueOutbox(operationId: string | null, msgs: OutboxDraft[]): Promise<void> {
    if (!msgs.length) return;
    const ds = await this.getDs();
    const { OutboxMessage } = await this.entities();
    await ds.getRepository(OutboxMessage).insert(msgs.map((o) => ({ operationId, kind: o.kind, payload: o.payload })));
  }

  async claimOutbox(limit: number, operationId?: string): Promise<OutboxRecord[]> {
    const ds = await this.getDs();
    const params: unknown[] = [limit, OUTBOX_VISIBILITY_MS / 1000];
    let opFilter = '';
    if (operationId) {
      params.push(operationId);
      opFilter = 'AND operation_id = $3';
    }
    const rows = await ds.query(
      `UPDATE outbox_messages SET status = 'sending', attempts = attempts + 1,
              available_at = now() + ($2 || ' seconds')::interval
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE status IN ('pending', 'sending') AND available_at <= now() ${opFilter}
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
      RETURNING id, operation_id, kind, payload, status, attempts, available_at, last_error`,
      params,
    );
    const list = Array.isArray(rows?.[0]) ? rows[0] : rows; // pg driver returns [rows, count] for UPDATE
    return (list || []).map((r: any) => ({
      id: r.id, operationId: r.operation_id, kind: r.kind, payload: r.payload, status: r.status,
      attempts: r.attempts, availableAt: new Date(r.available_at), lastError: r.last_error,
    }));
  }

  async completeOutbox(id: string, ok: boolean, error?: string, retryAt?: Date | null): Promise<void> {
    const ds = await this.getDs();
    const { OutboxMessage } = await this.entities();
    if (ok) {
      await ds.getRepository(OutboxMessage).update({ id }, { status: 'sent', sentAt: new Date(), lastError: null });
    } else {
      await ds.getRepository(OutboxMessage).update({ id }, retryAt
        ? { status: 'pending', availableAt: retryAt, lastError: error || 'failed' }
        : { status: 'failed', lastError: error || 'failed' });
    }
  }

  async cleanup(now = new Date()): Promise<void> {
    const ds = await this.getDs();
    await ds.query(`DELETE FROM outbox_messages WHERE status = 'sent' AND sent_at < $1`, [new Date(now.getTime() - OUTBOX_RETENTION_MS)]);
    await ds.query(`DELETE FROM idempotency_keys WHERE expires_at < $1`, [now]);
    await ds.query(`DELETE FROM webhook_deliveries WHERE received_at < $1`, [new Date(now.getTime() - 30 * 24 * 3600_000)]);
  }
}
