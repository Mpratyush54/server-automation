/**
 * Every test run gets its own throwaway directory for host-level state.
 *
 * Without this, code under test falls back to the real defaults
 * (/etc/platform/.env, /etc/platform/credentials, the OIDC signing key,
 * BACKUP_DIR) and, on a provisioned server, overwrites live credentials.
 * Individual tests may still point these elsewhere; they start sandboxed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-api-test-'));
const sandbox: Record<string, string> = {
  PLATFORM_ENV_FILE: path.join(root, '.env'),
  PLATFORM_CRED_DIR: path.join(root, 'credentials'),
  OIDC_SIGNING_KEY_FILE: path.join(root, 'oidc-signing-key.pem'),
  BACKUP_DIR: path.join(root, 'backups'),
};
for (const [key, value] of Object.entries(sandbox)) {
  if (!process.env[key]) process.env[key] = value;
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
