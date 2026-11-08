/**
 * Makes the generated InitialSchema DDL safe to run on a database that was
 * created by the old `synchronize: true` boot path (issue #17).
 *
 * Every statement becomes idempotent: on a fresh database the result is
 * exactly the generated schema; on an existing install, objects that are
 * already there are left untouched (no drops, no rewrites, no data changes)
 * and only missing tables, columns, enum types, indexes and constraints are
 * added. TypeORM derives index and constraint names deterministically from
 * table + columns, so names created by synchronize match the generated ones.
 *
 * Only the statement shapes TypeORM's postgres driver emits for a baseline
 * are accepted; anything else throws so a reviewer has to look at it.
 */

/** Split on top-level commas, ignoring commas inside (), '' and "". */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (body[i + 1] === quote) {
          current += body[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Rewrite one generated statement into one or more idempotent statements. */
export function idempotentStatement(raw: string): string[] {
  const sql = normalize(raw);

  let m = /^CREATE TYPE ("[^"]+"\."[^"]+"|"[^"]+") AS ENUM\s*\(/i.exec(sql);
  if (m) {
    return [`DO $baseline$ BEGIN ${sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $baseline$`];
  }

  m = /^CREATE TABLE ("[^"]+") \((.*)\)$/i.exec(sql);
  if (m) {
    const [, table, body] = m;
    const out = [`CREATE TABLE IF NOT EXISTS ${table} (${body})`];
    for (const part of splitTopLevel(body)) {
      if (/^CONSTRAINT\s/i.test(part)) continue;
      out.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${part}`);
    }
    return out;
  }

  m = /^CREATE (UNIQUE )?INDEX ("[^"]+") (ON .*)$/i.exec(sql);
  if (m) {
    return [`CREATE ${m[1] || ''}INDEX IF NOT EXISTS ${m[2]} ${m[3]}`];
  }

  m = /^ALTER TABLE ("[^"]+") ADD CONSTRAINT "([^"]+)" (.*)$/i.exec(sql);
  if (m) {
    return [
      `DO $baseline$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${sqlLiteral(m[2])}) THEN ` +
        `EXECUTE ${sqlLiteral(sql)}; END IF; END $baseline$`,
    ];
  }

  throw new Error(`baseline: unsupported statement, make it idempotent by hand: ${sql.slice(0, 120)}`);
}

export function idempotentStatements(statements: string[]): string[] {
  return statements.flatMap(idempotentStatement);
}
