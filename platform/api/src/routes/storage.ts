import { defaultUploadTarget, fileUploadStore } from '../lib/provider-upload-store';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { File, FileProvider } from '../entities/File';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { expressAuthenticate, sdkOrUserAuthenticate, sdkProjectMatches, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { resolveProjectRef } from '../lib/project-resolve';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { UPLOADS_DIR, containedUploadPath } from '../lib/upload-store';

export { UPLOADS_DIR, containedUploadPath };
const PRESIGN_TTL_SECONDS = 900;
const MAX_UPLOAD_BYTES = Number(process.env.STORAGE_MAX_UPLOAD_BYTES) || 100 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Types that are safe to render inline from the API origin. Everything else is served as a download. */
const INLINE_SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const router = Router();

/**
 * Display-only file name: no directory components, no control or shell-special characters.
 * Never used to build a filesystem path.
 */
export function sanitizeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return 'file';
  let n = name.replace(/\\/g, '/').split('/').pop() || '';
  n = n.replace(/[\x00-\x1f\x7f"<>|:*?]/g, '').trim();
  if (n === '.' || n === '..') n = '';
  return n.slice(0, 255) || 'file';
}

/** Object key of an upload — derived from server-generated ids, never client input. */
function objectKey(file: File): string | null {
  if (!UUID_RE.test(file.id) || !UUID_RE.test(String(file.projectId))) return null;
  return `${file.projectId}/${file.id}`;
}

/** Physical path of a pre-object-storage upload — always the server-generated UUID. */
function physicalPath(file: File): string | null {
  if (!UUID_RE.test(file.id)) return null;
  return containedUploadPath(file.id);
}

/** Files written by older versions were stored as `${id}-${originalName}`; only read them if contained. */
function legacyPhysicalPath(file: File): string | null {
  if (!UUID_RE.test(file.id) || typeof file.originalName !== 'string') return null;
  return containedUploadPath(`${file.id}-${file.originalName}`);
}

function existingPhysicalPath(file: File): string | null {
  const current = physicalPath(file);
  if (current && fs.existsSync(current)) return current;
  const legacy = legacyPhysicalPath(file);
  if (legacy && fs.existsSync(legacy)) return legacy;
  return null;
}

/**
 * Authorize the caller for a project. SDK tokens must be bound to that project;
 * humans need project membership (or a global admin/devops role).
 */
async function authorizeProject(
  req: Request,
  res: Response,
  projectId: string,
  minRole: ProjectAccessRole,
): Promise<boolean> {
  const authReq = req as AuthenticatedRequest;
  if (authReq.sdkToken) {
    if (authReq.projectId !== projectId) {
      res.status(403).json({ error: 'Forbidden: SDK token is not valid for this project' });
      return false;
    }
    return true;
  }
  const access = await requireProjectAccess(authReq, projectId, minRole);
  if (access.ok === false) {
    res.status(access.status).json({ error: access.error });
    return false;
  }
  return true;
}

async function loadFile(fileId: unknown): Promise<File | null> {
  if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) return null;
  const ds = await getDb();
  return ds.getRepository(File).findOne({ where: { id: fileId } });
}

router.post('/storage/upload-url', sdkOrUserAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const body = req.body || {};
    const { fileName, mimeType, provider, bucket, category } = body;

    let projectId: string;
    if (authReq.sdkToken) {
      if (!sdkProjectMatches(authReq, body.projectId)) {
        return res.status(403).json({ error: 'Forbidden: SDK token is not valid for this project' });
      }
      projectId = authReq.projectId!;
    } else {
      if (!body.projectId || typeof body.projectId !== 'string') {
        return res.status(400).json({ error: 'projectId is required' });
      }
      const ds = await getDb();
      const ref = await resolveProjectRef(ds, body.projectId);
      if (!ref) return res.status(404).json({ error: 'Project not found' });
      if (!(await authorizeProject(req, res, ref.id, ProjectAccessRole.DEVELOPER))) return;
      projectId = ref.id;
    }

    if (provider !== undefined && !Object.values(FileProvider).includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Allowed: ${Object.values(FileProvider).join(', ')}` });
    }

    const ds = await getDb();
    const repo = ds.getRepository(File);

    const fileId = uuidv4();
    const displayName = sanitizeDisplayName(fileName);
    const storageKey = `${projectId}/${fileId}`;
    const { store, providerId, providerType } = await defaultUploadTarget();

    const file = repo.create({
      id: fileId,
      projectId,
      provider: store.kind === 's3' ? (providerType === 's3' ? FileProvider.S3 : FileProvider.MINIO) : FileProvider.LOCAL,
      bucket: store.kind === 's3'
        ? store.bucket
        : (typeof bucket === 'string' && bucket ? bucket.slice(0, 200) : 'default-bucket'),
      storageKey,
      storageProviderId: providerId,
      originalName: displayName,
      mimeType: typeof mimeType === 'string' && mimeType ? mimeType.slice(0, 100) : null,
      category: typeof category === 'string' && category ? category.slice(0, 100) : null,
      uploadedById: authReq.user?.id || null,
    });
    await repo.save(file);

    // `url` streams through the API (same credentials; works everywhere).
    // `presignedUrl` is a direct object-store PUT, only when a public S3
    // endpoint is configured (UPLOADS_S3_PUBLIC_ENDPOINT).
    const url = `/api/storage/upload-raw/${fileId}`;
    const presignedUrl = store.presign('PUT', storageKey, PRESIGN_TTL_SECONDS);
    return res.status(201).json(presignedUrl
      ? { url, fileId, presignedUrl, presignedMethod: 'PUT', expiresIn: PRESIGN_TTL_SECONDS }
      : { url, fileId });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Endpoint called by SDK to perform direct local uploads
router.put('/storage/upload-raw/:fileId', sdkOrUserAuthenticate, async (req: Request, res: Response) => {
  try {
    const file = await loadFile(req.params.fileId);
    if (!file || file.isDeleted) return res.status(404).json({ error: 'File registration not found' });
    if (!(await authorizeProject(req, res, file.projectId, ProjectAccessRole.DEVELOPER))) return;

    const key = objectKey(file);
    if (!key) return res.status(400).json({ error: 'Invalid file id' });

    // Spool to a private temp file (bounded), then hand it to the object store.
    const filePath = path.join(os.tmpdir(), `platform-upload-${file.id}-${uuidv4()}`);
    const ds = await getDb();
    const uploadStore = await fileUploadStore(file);
    const writeStream = fs.createWriteStream(filePath, { mode: 0o600 });
    let written = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > MAX_UPLOAD_BYTES && !aborted) {
        aborted = true;
        req.unpipe(writeStream);
        writeStream.destroy();
        fs.unlink(filePath, () => {});
        res.status(413).json({ error: `Upload exceeds ${MAX_UPLOAD_BYTES} bytes` });
      }
    });
    writeStream.on('finish', () => {
      if (aborted) return;
      const stats = fs.statSync(filePath);
      file.size = stats.size;
      uploadStore.put(key, filePath, file.mimeType)
        .then(() => ds.getRepository(File).save(file))
        .then(() => res.json({ success: true, size: stats.size }))
        .catch((e: any) => {
          fs.unlink(filePath, () => {});
          if (!res.headersSent) res.status(500).json({ error: e.message });
        });
    });
    writeStream.on('error', (e: any) => {
      if (aborted || res.headersSent) return;
      res.status(500).json({ error: e.message });
    });
    req.pipe(writeStream);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/storage/confirm', sdkOrUserAuthenticate, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const { fileId, size, cdnUrl } = body;

    const file = await loadFile(fileId);
    if (!file || file.isDeleted) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!(await authorizeProject(req, res, file.projectId, ProjectAccessRole.DEVELOPER))) return;

    if (size !== undefined) {
      const n = Number(size);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'size must be a non-negative number' });
      file.size = n;
    }
    // Only accept an external https CDN URL; otherwise use the API route.
    file.cdnUrl = typeof cdnUrl === 'string' && /^https:\/\//i.test(cdnUrl)
      ? cdnUrl
      : `/api/storage/file/${file.id}`;
    const ds = await getDb();
    await ds.getRepository(File).save(file);
    return res.json(file);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/storage/delete', sdkOrUserAuthenticate, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.body || {};
    const file = await loadFile(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!(await authorizeProject(req, res, file.projectId, ProjectAccessRole.DEVELOPER))) return;

    const ds = await getDb();
    file.isDeleted = true;
    file.deletedAt = new Date();
    await ds.getRepository(File).save(file);

    const key = objectKey(file);
    if (key) {
      try {
        await (await fileUploadStore(file)).delete(key);
      } catch (e: any) {
        console.warn(`[storage] object delete failed for ${file.id}: ${e.message}`);
      }
    }
    // Pre-object-storage local file, if any (contained paths only)
    const filePath = existingPhysicalPath(file);
    if (filePath) {
      fs.unlinkSync(filePath);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/file/:id', sdkOrUserAuthenticate, async (req: Request, res: Response) => {
  try {
    const file = await loadFile(req.params.id);
    if (!file || file.isDeleted) return res.status(404).json({ error: 'File not found' });
    if (!(await authorizeProject(req, res, file.projectId, ProjectAccessRole.VIEWER))) return;

    const key = objectKey(file);
    const store = await fileUploadStore(file);
    if (key && req.query.presigned === '1') {
      const presignedUrl = store.presign('GET', key, PRESIGN_TTL_SECONDS);
      if (presignedUrl) return res.json({ url: presignedUrl, expiresIn: PRESIGN_TTL_SECONDS });
    }
    let body: NodeJS.ReadableStream | null = key ? await store.get(key) : null;
    if (!body) {
      const legacy = existingPhysicalPath(file);
      if (legacy) body = fs.createReadStream(legacy);
    }
    if (!body) return res.status(404).json({ error: 'Physical file not found' });

    const mime = (file.mimeType || 'application/octet-stream').toLowerCase();
    const inline = INLINE_SAFE_TYPES.has(mime);
    res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const safeName = sanitizeDisplayName(file.originalName).replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    body.on('error', (e: any) => {
      if (!res.headersSent) res.status(500).json({ error: e.message });
      else res.destroy(e);
    });
    body.pipe(res);
    return;
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/project/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await authorizeProject(req, res, req.params.projectId, ProjectAccessRole.VIEWER))) return;
    const ds = await getDb();
    const files = await ds.getRepository(File).find({
      where: { projectId: req.params.projectId, isDeleted: false },
    });
    return res.json(files);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/analytics/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await authorizeProject(req, res, req.params.projectId, ProjectAccessRole.VIEWER))) return;
    const ds = await getDb();
    const files = await ds.getRepository(File).find({
      where: { projectId: req.params.projectId, isDeleted: false },
    });
    const totalBytes = files.reduce((acc, f) => acc + Number(f.size || 0), 0);
    const count = files.length;
    return res.json({
      totalBytes,
      count,
      providerBreakdown: files.reduce((acc: Record<string, number>, f) => {
        const k = f.provider || 'local';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
