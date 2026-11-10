/**
 * Environment variables view (#29): one list per environment that merges the two existing
 * stores — plain values in `project_configs` and AES-encrypted values in `secrets`.
 *
 * Storage stays split; this module only aggregates for reading and, for writes, keeps a key in
 * exactly one store per scope. Converting plain → secret (or back) happens in a single DB
 * transaction so plaintext never survives next to its encrypted copy.
 *
 * Workloads are unaffected: they keep reading the merged map from GET /sdk/config.
 */
import { DataSource, EntityManager } from 'typeorm';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { SecretVersion } from '../entities/SecretVersion';
import { encryptValue, decryptValue } from './secrets-encryption';

export type EnvVarType = 'plain' | 'secret';

export interface EnvironmentRow {
  key: string;
  type: EnvVarType;
  /** Plain value, or null when masked (secrets always; plain values for viewers). */
  value: string | null;
  masked: boolean;
  /** Stored scope: null = global (all environments), otherwise the environment id/name stored on the row. */
  environmentId: string | null;
  scope: 'global' | 'environment';
  version: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Secret row id (version history / rollback); null for plain rows. */
  secretId: string | null;
  /** Same key stored both as plain and as secret in the same scope — needs resolution. */
  conflict: boolean;
  /** Legacy plain row flagged `isSecret` (masked but stored in plaintext). */
  legacyMasked?: boolean;
}

/** Key rule: env-var style plus dots/dashes (existing config keys such as `database.pool_size`). */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;

export function isValidEnvKey(key: unknown): key is string {
  return typeof key === 'string' && ENV_KEY_RE.test(key);
}

export interface ScopeFilter {
  /** undefined = every scope; null = global rows only; otherwise effective rows for that environment. */
  match?: string[] | null;
}

/** True when a stored row's environmentId belongs to the requested view. */
export function inScope(rowEnv: string | null | undefined, filter: ScopeFilter): boolean {
  if (filter.match === undefined) return true;
  if (!rowEnv) return true; // global rows apply to every environment
  if (filter.match === null) return false;
  return filter.match.includes(rowEnv);
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Merge plain config rows and active secret rows into one sorted list. Secret values are never
 * included; plain values only when `canReadValues`.
 */
export function buildEnvironmentRows(
  configs: Pick<ProjectConfig, 'key' | 'value' | 'environmentId' | 'isSecret' | 'changedById' | 'changedAt'>[],
  secrets: Pick<Secret, 'id' | 'key' | 'environmentId' | 'version' | 'createdById' | 'updatedAt' | 'isActive'>[],
  opts: { filter: ScopeFilter; canReadValues: boolean; userNames?: Record<string, string> },
): EnvironmentRow[] {
  const name = (id: string | null | undefined) => (id ? opts.userNames?.[id] || id : null);
  const rows: EnvironmentRow[] = [];
  for (const c of configs) {
    if (!inScope(c.environmentId, opts.filter)) continue;
    const masked = !opts.canReadValues || !!c.isSecret;
    rows.push({
      key: c.key,
      type: 'plain',
      value: masked ? null : c.value,
      masked,
      environmentId: c.environmentId || null,
      scope: c.environmentId ? 'environment' : 'global',
      version: null,
      updatedBy: name(c.changedById),
      updatedAt: iso(c.changedAt),
      secretId: null,
      conflict: false,
      ...(c.isSecret ? { legacyMasked: true } : {}),
    });
  }
  for (const s of secrets) {
    if (s.isActive === false) continue;
    if (!inScope(s.environmentId, opts.filter)) continue;
    rows.push({
      key: s.key,
      type: 'secret',
      value: null,
      masked: true,
      environmentId: s.environmentId || null,
      scope: s.environmentId ? 'environment' : 'global',
      version: s.version ?? null,
      updatedBy: name(s.createdById),
      updatedAt: iso(s.updatedAt),
      secretId: s.id,
      conflict: false,
    });
  }
  // A key stored in both stores within the same scope is a conflict.
  // Request-scoped lookup (plain object: tests/unit/no-in-memory-state.test.ts forbids new Map in src).
  const seen: Record<string, { plain?: boolean; secret?: boolean }> = {};
  const id = (r: EnvironmentRow) => `${r.environmentId || ''}\u0000${r.key}`;
  for (const r of rows) (seen[id(r)] ||= {})[r.type] = true;
  for (const r of rows) r.conflict = !!(seen[id(r)].plain && seen[id(r)].secret);
  rows.sort((a, b) => a.key.localeCompare(b.key)
    || (a.environmentId || '').localeCompare(b.environmentId || '')
    || a.type.localeCompare(b.type));
  return rows;
}

export interface SetVariableInput {
  projectId: string;
  /** null / '' = global scope. */
  environmentId: string | null;
  key: string;
  /** undefined = keep the current value (only valid when converting between stores). */
  value?: string;
  secret: boolean;
  userId: string | null;
  masterKey: string;
}

export interface SetVariableResult {
  key: string;
  type: EnvVarType;
  environmentId: string | null;
  /** 'created' | 'updated' within the target store. */
  status: 'created' | 'updated';
  /** Set when the key moved between stores (the source row was deleted in the same transaction). */
  convertedFrom: EnvVarType | null;
  version: number | null;
  secretId: string | null;
}

export class EnvVarError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Existing rows for one key in one scope (both stores). */
export async function findVariable(
  m: Pick<EntityManager, 'getRepository'>,
  projectId: string,
  environmentId: string | null,
  key: string,
): Promise<{ plain: ProjectConfig | null; secret: Secret | null }> {
  const plain = await m.getRepository(ProjectConfig).findOne({ where: { projectId, environmentId, key } as any });
  const secret = await m.getRepository(Secret).findOne({ where: { projectId, environmentId, key, isActive: true } as any });
  return { plain: plain || null, secret: secret || null };
}

/**
 * Write one variable into the store chosen by `secret`, deleting the copy in the other store
 * (plain → secret removes the plaintext row; secret → plain deactivates the secret) inside one
 * transaction. Secret updates keep the previous ciphertext in `secret_versions` like the
 * existing secrets routes.
 */
export async function setEnvironmentVariable(ds: Pick<DataSource, 'transaction'>, input: SetVariableInput): Promise<SetVariableResult> {
  const environmentId = input.environmentId || null;
  return ds.transaction(async (m: EntityManager) => {
    const { plain, secret } = await findVariable(m, input.projectId, environmentId, input.key);
    const configRepo = m.getRepository(ProjectConfig);
    const secretRepo = m.getRepository(Secret);
    const versionRepo = m.getRepository(SecretVersion);

    let value = input.value;
    if (value === undefined) {
      // Pure conversion: carry the stored value across.
      if (input.secret && plain) value = plain.value;
      else if (!input.secret && secret) value = decryptValue(secret.encryptedValue, input.masterKey);
      else throw new EnvVarError(400, 'value is required');
    }

    if (input.secret) {
      if (!input.masterKey) throw new EnvVarError(500, 'SECRETS_ENCRYPTION_KEY not configured');
      const encrypted = encryptValue(String(value), input.masterKey);
      let row: Secret;
      let status: 'created' | 'updated';
      if (secret) {
        await versionRepo.save(versionRepo.create({
          secretId: secret.id,
          encryptedValue: secret.encryptedValue,
          version: secret.version,
          changedById: input.userId,
        }));
        secret.encryptedValue = encrypted;
        secret.version += 1;
        secret.createdById = input.userId;
        row = await secretRepo.save(secret);
        status = 'updated';
      } else {
        row = await secretRepo.save(secretRepo.create({
          projectId: input.projectId,
          key: input.key,
          encryptedValue: encrypted,
          environmentId,
          version: 1,
          isActive: true,
          createdById: input.userId,
        }));
        status = 'created';
      }
      if (plain) await configRepo.delete({ id: plain.id });
      return {
        key: input.key, type: 'secret', environmentId, status,
        convertedFrom: plain ? 'plain' : null, version: row.version, secretId: row.id,
      };
    }

    let status: 'created' | 'updated';
    if (plain) {
      plain.value = String(value);
      plain.isSecret = false;
      plain.changedById = input.userId;
      await configRepo.save(plain);
      status = 'updated';
    } else {
      await configRepo.save(configRepo.create({
        projectId: input.projectId,
        key: input.key,
        value: String(value),
        environmentId,
        isSecret: false,
        changedById: input.userId,
      }));
      status = 'created';
    }
    if (secret) {
      // Same soft delete as DELETE /projects/:id/secrets/:secretId (history stays for audit).
      await secretRepo.update({ id: secret.id } as any, { isActive: false } as any);
    }
    return {
      key: input.key, type: 'plain', environmentId, status,
      convertedFrom: secret ? 'secret' : null, version: null, secretId: null,
    };
  });
}

/** Remove one variable from one store. Returns false when nothing matched. */
export async function deleteEnvironmentVariable(
  ds: Pick<DataSource, 'transaction'>,
  input: { projectId: string; environmentId: string | null; key: string; type: EnvVarType },
): Promise<{ deleted: boolean; secretId: string | null }> {
  const environmentId = input.environmentId || null;
  return ds.transaction(async (m: EntityManager) => {
    const { plain, secret } = await findVariable(m, input.projectId, environmentId, input.key);
    if (input.type === 'plain') {
      if (!plain) return { deleted: false, secretId: null };
      await m.getRepository(ProjectConfig).delete({ id: plain.id });
      return { deleted: true, secretId: null };
    }
    if (!secret) return { deleted: false, secretId: null };
    await m.getRepository(Secret).update({ id: secret.id } as any, { isActive: false } as any);
    return { deleted: true, secretId: secret.id };
  });
}
