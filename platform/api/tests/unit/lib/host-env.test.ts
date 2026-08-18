import fs from 'fs';
import os from 'os';
import path from 'path';
import { persistPlatformEnv, upsertDotEnvFile } from '../../../src/lib/host-env';

describe('host-env persist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-env-'));

  beforeEach(() => {
    process.env.PLATFORM_ENV_FILE = path.join(root, '.env');
    process.env.PLATFORM_CRED_DIR = path.join(root, 'credentials');
    fs.writeFileSync(process.env.PLATFORM_ENV_FILE, 'GITHUB_TOKEN=keep\nPOSTGRES_PASSWORD=old\n');
  });

  afterEach(() => {
    delete process.env.PLATFORM_ENV_FILE;
    delete process.env.PLATFORM_CRED_DIR;
  });

  it('writes credential files and upserts .env without dropping other keys', () => {
    const result = persistPlatformEnv({
      POSTGRES_PASSWORD: 'new-pg',
      POSTGRES_PASSWORD_PREV: 'old',
      POSTGRES_PASSWORD_NEXT: 'new-pg',
      ADMIN_PASSWORD: 'admin-secret',
    });
    expect(result.ok).toBe(true);
    const env = fs.readFileSync(process.env.PLATFORM_ENV_FILE!, 'utf8');
    expect(env).toContain('GITHUB_TOKEN=keep');
    expect(env).toContain('POSTGRES_PASSWORD=new-pg');
    expect(fs.readFileSync(path.join(root, 'credentials', 'postgres'), 'utf8').trim()).toBe('new-pg');
    expect(fs.readFileSync(path.join(root, 'credentials', 'postgres.prev'), 'utf8').trim()).toBe('old');
    expect(fs.readFileSync(path.join(root, 'credentials', 'postgres.next'), 'utf8').trim()).toBe('new-pg');
  });

  it('upsertDotEnvFile keeps unrelated keys', () => {
    const file = path.join(root, 'only.env');
    fs.writeFileSync(file, 'A=1\nB=2\n');
    upsertDotEnvFile(file, { B: '3' });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('A=1');
    expect(text).toContain('B=3');
  });
});
