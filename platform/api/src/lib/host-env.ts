import fs from 'fs';
import path from 'path';

export function platformEnvFile(): string {
  return process.env.PLATFORM_ENV_FILE || '/etc/platform/.env';
}

export function platformCredDir(): string {
  return process.env.PLATFORM_CRED_DIR || '/etc/platform/credentials';
}

function fsyncWrite(filePath: string, content: string): void {
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
  fsyncWrite(filePath, lines.join('\n'));
}

export function persistPlatformEnv(values: Record<string, string>): { ok: boolean; detail: string } {
  try {
    const credDir = platformCredDir();
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
    const fileFor: Record<string, string> = {
      POSTGRES_PASSWORD: 'postgres',
      REDIS_PASSWORD: 'redis',
      ADMIN_PASSWORD: 'admin',
      POSTGRES_PASSWORD_PREV: 'postgres.prev',
      POSTGRES_PASSWORD_NEXT: 'postgres.next',
      REDIS_PASSWORD_PREV: 'redis.prev',
      REDIS_PASSWORD_NEXT: 'redis.next',
    };
    const envPatch: Record<string, string> = {};
    for (const [key, file] of Object.entries(fileFor)) {
      const v = values[key];
      if (!v) continue;
      fsyncWrite(path.join(credDir, file), `${v}\n`);
      if (key === 'POSTGRES_PASSWORD' || key === 'REDIS_PASSWORD' || key === 'ADMIN_PASSWORD') {
        envPatch[key] = v;
      }
    }
    if (Object.keys(envPatch).length > 0) {
      upsertDotEnvFile(platformEnvFile(), envPatch);
    }
    return { ok: true, detail: `wrote ${platformEnvFile()} and ${credDir}` };
  } catch (err: any) {
    return { ok: false, detail: err?.message || 'host persist failed' };
  }
}
