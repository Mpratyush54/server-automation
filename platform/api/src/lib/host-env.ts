import fs from 'fs';
import path from 'path';

/**
 * Dotenv helpers for the FileStore (local development and tests).
 *
 * In the cluster the API does not read or write /etc/platform: configuration
 * lives in Kubernetes Secrets (see config-store.ts). platformctl keeps the
 * host files as an operator-side break-glass copy.
 */
export function platformEnvFile(): string {
  return process.env.PLATFORM_ENV_FILE || '/etc/platform/.env';
}

export function platformCredDir(): string {
  return process.env.PLATFORM_CRED_DIR || '/etc/platform/credentials';
}

/**
 * Defence in depth: tests must never write the real host config. Jest setup
 * sandboxes these paths; this throws if a test somehow still targets them.
 */
function assertNotHostPathInTests(filePath: string): void {
  if (process.env.NODE_ENV === 'test' && path.resolve(filePath).startsWith('/etc/platform')) {
    throw new Error(`refusing to write ${filePath} under NODE_ENV=test; set PLATFORM_ENV_FILE/PLATFORM_CRED_DIR`);
  }
}

/** Atomic, fsync'd 0600 write (tmp file + rename). */
export function writeFileAtomic(filePath: string, content: string): void {
  assertNotHostPathInTests(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  const fd = fs.openSync(tmp, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, filePath);
}

export function upsertDotEnvFile(filePath: string, values: Record<string, string>): void {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    text = '';
  }
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const prefix = `${key}=`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith(prefix)) {
        lines[i] = prefix + value;
        found = true;
      }
    }
    if (!found) {
      if (lines.length && lines[lines.length - 1] === '') {
        lines[lines.length - 1] = prefix + value;
        lines.push('');
      } else {
        lines.push(prefix + value);
      }
    }
  }
  writeFileAtomic(filePath, lines.join('\n'));
}

/**
 * Durably store credentials (and rotation write-ahead copies) in the
 * credentials ConfigStore: the platform-credentials Secret in the cluster,
 * PLATFORM_ENV_FILE + PLATFORM_CRED_DIR elsewhere.
 */
export async function persistPlatformEnv(values: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  try {
    const { credentialsStore } = await import('./config-store');
    const store = await credentialsStore();
    await store.patch(values);
    return { ok: true, detail: `wrote ${store.description}` };
  } catch (err: any) {
    return { ok: false, detail: err?.message || 'credential persist failed' };
  }
}
