import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { File, FileProvider } from '../entities/File';
import { expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const router = Router();

router.post('/storage/upload-url', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const { projectId, fileName, mimeType, provider, bucket, category, uploadedById } = body;

    const ds = await getDb();
    const repo = ds.getRepository(File);

    const fileId = uuidv4();
    const storageKey = `${projectId}/${fileId}/${fileName || 'unnamed'}`;

    const file = repo.create({
      id: fileId,
      projectId,
      provider: provider || FileProvider.LOCAL,
      bucket: bucket || 'default-bucket',
      storageKey,
      originalName: fileName || 'file',
      mimeType: mimeType || null,
      category: category || null,
      uploadedById: uploadedById || null,
    });
    await repo.save(file);

    // Express local upload URL helper
    const url = `/api/storage/upload-raw/${fileId}`;
    return res.status(201).json({ url, fileId });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Endpoint called by SDK to perform direct local uploads
router.put('/storage/upload-raw/:fileId', async (req: Request, res: Response) => {
  try {
    const fileId = req.params.fileId;
    const ds = await getDb();
    const file = await ds.getRepository(File).findOne({ where: { id: fileId } });
    if (!file) return res.status(404).json({ error: 'File registration not found' });

    const filePath = path.join(UPLOADS_DIR, `${fileId}-${file.originalName}`);
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);

    req.on('end', () => {
      const stats = fs.statSync(filePath);
      file.size = stats.size;
      ds.getRepository(File).save(file).then(() => {
        return res.json({ success: true, size: stats.size });
      });
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/storage/confirm', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const { fileId, size, cdnUrl } = body;

    const ds = await getDb();
    const repo = ds.getRepository(File);
    const file = await repo.findOne({ where: { id: fileId } });
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (size !== undefined) file.size = size;
    file.cdnUrl = cdnUrl || `/api/storage/file/${fileId}`;
    await repo.save(file);
    return res.json(file);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/storage/delete', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.body;
    const ds = await getDb();
    const file = await ds.getRepository(File).findOne({ where: { id: fileId } });
    if (!file) return res.status(404).json({ error: 'File not found' });

    file.isDeleted = true;
    file.deletedAt = new Date();
    await ds.getRepository(File).save(file);

    // Delete local physical file if it exists
    const filePath = path.join(UPLOADS_DIR, `${fileId}-${file.originalName}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/file/:id', async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const file = await ds.getRepository(File).findOne({ where: { id: req.params.id } });
    if (!file || file.isDeleted) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(UPLOADS_DIR, `${file.id}-${file.originalName}`);
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      return res.sendFile(filePath);
    }
    return res.status(404).json({ error: 'Physical file not found' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/project/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
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
