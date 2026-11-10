import { IsNull, Not } from 'typeorm';
import fs from 'fs';
import { getDb } from '../config/database';
import { File, FileProvider } from '../entities/File';
import { StorageProvider } from '../entities/StorageProvider';
import { containedUploadPath } from './upload-store';
import { providerUploadStore } from './provider-upload-store';
import { defineOperation } from './operations';

/** Row updates are the checkpoint: a crash repeats only the current object PUT. */
defineOperation({
  type: 'storage.migrate-local', resume: 'continue',
  steps: [{ name: 'copy-local-files', async run(ctx) {
    const ds = await getDb();
    const provider = await ds.getRepository(StorageProvider).findOneBy({ id: String(ctx.input.providerId) });
    if (!provider) throw new Error('Destination provider is unavailable');
    const store = providerUploadStore(provider);
    const repo = ds.getRepository(File);
    let copied = 0;
    for (;;) {
      // Bounded batches; no deletion of local originals, so rollback remains possible.
      const files = await repo.find({ where: { provider: FileProvider.LOCAL, isDeleted: false, size: Not(IsNull()) }, order: { id: 'ASC' }, take: 100 });
      if (!files.length) break;
      for (const file of files) {
        const current = containedUploadPath(file.id);
        const legacy = containedUploadPath(`${file.id}-${file.originalName}`);
        const source = current && fs.existsSync(current) ? current : legacy && fs.existsSync(legacy) ? legacy : null;
        if (!source) throw new Error(`Local source unavailable for file ${file.id}; restore the local upload volume before retrying`);
        const key = `${file.projectId}/${file.id}`;
        // S3UploadStore.put consumes its temp source. Copy first to keep the original.
        const os = await import('os'); const path = await import('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-storage-migrate-'));
        const temp = path.join(dir, 'object');
        try {
          fs.copyFileSync(source, temp);
          await store.put(key, temp, file.mimeType);
          await repo.update(file.id, { storageProviderId: provider.id, provider: provider.providerType === 'minio' ? FileProvider.MINIO : FileProvider.S3, bucket: store.bucket, storageKey: key });
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        copied++;
      }
      ctx.setOutput({ copied });
    }
    ctx.setOutput({ copied });
  } }],
});
