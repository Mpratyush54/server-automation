import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { File, FileProvider } from '../entities/File';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { expressAuthenticate, sdkOrUserAuthenticate, sdkProjectMatches, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { resolveProjectRef } from '../lib/project-resolve';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
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

/** Resolve `name` inside UPLOADS_DIR; returns null if the result would escape the directory. */
export function containedUploadPath(name: string): string | null {
  const resolved = path.resolve(UPLOADS_DIR, name);
  if (path.dirname(resolved) !== UPLOADS_DIR) return null;
  return resolved;
}

/** Physical path of an upload — always the server-generated UUID, never client input. */
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

    const file = repo.create({
      id: fileId,
      projectId,
      provider: provider || FileProvider.LOCAL,
      bucket: typeof bucket === 'string' && bucket ? bucket.slice(0, 200) : 'default-bucket',
      storageKey,
      originalName: displayName,
      mimeType: typeof mimeType === 'string' && mimeType ? mimeType.slice(0, 100) : null,
      category: typeof category === 'string' && category ? category.slice(0, 100) : null,
      uploadedById: authReq.user?.id || null,
    });
    await repo.save(file);

    // Express local upload URL helper (requires the same credentials)
    const url = `/api/storage/upload-raw/${fileId}`;
    return res.status(201).json({ url, fileId });
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

    const filePath = physicalPath(file);
    if (!filePath) return res.status(400).json({ error: 'Invalid file id' });

    const ds = await getDb();
    const writeStream = fs.createWriteStream(filePath);
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
      ds.getRepository(File).save(file).then(() => {
        return res.json({ success: true, size: stats.size });
      }).catch((e: any) => res.status(500).json({ error: e.message }));
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

    // Delete local physical file if it exists (contained paths only)
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

    const filePath = existingPhysicalPath(file);
    if (filePath) {
      const mime = (file.mimeType || 'application/octet-stream').toLowerCase();
      const inline = INLINE_SAFE_TYPES.has(mime);
      res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const safeName = sanitizeDisplayName(file.originalName).replace(/[^\x20-\x7e]/g, '_');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
      return res.sendFile(filePath);
    }
    return res.status(404).json({ error: 'Physical file not found' });
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
      providerBreakdown: {
        local: count,
      },
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
