/**
 * Minimal in-memory stand-in for a TypeORM repository (findOne/find/count/save/create/update/
 * delete) with support for the IsNull() and LessThan() find operators used by lib/mfa.ts.
 */
import { randomUUID } from 'crypto';

function matches(row: any, where: Record<string, any> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && typeof (cond as any).type === 'string' && '_type' in cond) {
      const op = cond as any;
      if (op.type === 'isNull') return v === null || v === undefined;
      if (op.type === 'lessThan') return v !== null && v !== undefined && v < op.value;
      throw new Error(`memory-repo: unsupported operator ${op.type}`);
    }
    if (cond === undefined) throw new Error(`memory-repo: undefined condition for ${k}`);
    return v === cond;
  });
}

export class MemoryRepo<T extends Record<string, any>> {
  rows: T[] = [];

  constructor(private readonly defaults: () => Partial<T> = () => ({})) {}

  create(data: Partial<T> = {}): T {
    return { ...this.defaults(), ...data } as T;
  }

  async findOne(opts: { where?: Record<string, any> } = {}): Promise<T | null> {
    const row = this.rows.find((r) => matches(r, opts.where));
    return row ? { ...row } : null;
  }

  async find(opts: { where?: Record<string, any>; take?: number } = {}): Promise<T[]> {
    const out = this.rows.filter((r) => matches(r, opts.where)).map((r) => ({ ...r }));
    return typeof opts.take === 'number' ? out.slice(0, opts.take) : out;
  }

  async count(opts: { where?: Record<string, any> } = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, opts.where)).length;
  }

  async save(entity: T | T[]): Promise<any> {
    const list = Array.isArray(entity) ? entity : [entity];
    for (const e of list) {
      if (!e.id) (e as any).id = randomUUID();
      const idx = this.rows.findIndex((r) => r.id === e.id);
      if (idx >= 0) this.rows[idx] = { ...this.rows[idx], ...e };
      else this.rows.push({ ...e });
    }
    return entity;
  }

  async update(where: Record<string, any>, patch: Partial<T>): Promise<{ affected: number }> {
    let affected = 0;
    for (const r of this.rows) {
      if (matches(r, where)) {
        Object.assign(r, patch);
        affected++;
      }
    }
    return { affected };
  }

  async delete(where: Record<string, any>): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { affected: before - this.rows.length };
  }
}
