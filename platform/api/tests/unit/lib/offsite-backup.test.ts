/**
 * The off-site backup target read from platformctl's ConfigMap and Secret: used only when
 * configured, never silently replaced by on-cluster storage when it cannot be read.
 */
import { offsiteKey, parseOffsiteSecret, readOffsiteTarget, setOffsiteReaderForTests, OFFSITE_FILE_PREFIX } from '../../../src/lib/offsite-backup';

const b64 = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const full = { endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'cairn-backups', region: '', prefix: '/prod/', 'access-key': 'AK', 'secret-key': 'SK' };

afterEach(() => setOffsiteReaderForTests(null));

it('parses the Secret written by platformctl', () => {
  expect(parseOffsiteSecret(b64(full))).toEqual({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'cairn-backups', region: '', prefix: 'prod', accessKey: 'AK', secretKey: 'SK' });
  expect(parseOffsiteSecret(b64({ ...full, 'secret-key': '' }))).toBeNull();
  expect(parseOffsiteSecret(undefined)).toBeNull();
});

it('returns null when no off-site target is configured', async () => {
  setOffsiteReaderForTests(async () => ({ mode: null, secret: null }));
  await expect(readOffsiteTarget()).resolves.toBeNull();
  setOffsiteReaderForTests(async () => ({ mode: 'local', secret: null }));
  await expect(readOffsiteTarget()).resolves.toBeNull();
});

it('returns the target in external mode', async () => {
  setOffsiteReaderForTests(async () => ({ mode: 'external', secret: b64(full) }));
  const t = await readOffsiteTarget();
  expect(t?.bucket).toBe('cairn-backups');
  expect(offsiteKey(t!, 'backups/p/x.dump')).toBe('prod/backups/p/x.dump');
  expect(offsiteKey({ prefix: '' }, 'backups/p/x.dump')).toBe('backups/p/x.dump');
  expect(OFFSITE_FILE_PREFIX).toBe('offsite:');
});

it('fails instead of falling back when the configured target cannot be read', async () => {
  setOffsiteReaderForTests(async () => ({ mode: 'external', secret: b64({ ...full, 'access-key': '' }) }));
  await expect(readOffsiteTarget()).rejects.toThrow(/credentials are incomplete/);
  setOffsiteReaderForTests(async () => { throw new Error('forbidden'); });
  await expect(readOffsiteTarget()).rejects.toThrow('forbidden');
});
