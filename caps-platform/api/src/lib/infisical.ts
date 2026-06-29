import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import { decryptValue } from './secrets-encryption';

const MASTER_KEY = () => process.env.SECRETS_ENCRYPTION_KEY || '';

export async function fetchSecrets(projectId: string, environment: string): Promise<Record<string, string>> {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Secret);
    const secrets = await repo.find({
      where: { projectId, environmentId: environment, isActive: true },
    });
    const key = MASTER_KEY();
    if (!key) return {};

    const result: Record<string, string> = {};
    for (const secret of secrets) {
      try {
        result[secret.key] = decryptValue(secret.encryptedValue, key);
      } catch {}
    }
    return result;
  } catch { return {}; }
}
