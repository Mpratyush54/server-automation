/**
 * C3 regressions — storage routes: auth + project membership on every route,
 * server-generated physical filenames, resolved-path containment.
 */
const PROJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SDK_TOKEN_A = 'sdk_live_projectAtoken0000000000000000';

const users: Record<string, any> = {
  'uid-devops': { id: 'uid-devops', role: 'devops', roleId: null, name: 'D', email: 'd@io', isActive: true },
  'uid-dev': { id: 'uid-dev', role: 'developer', roleId: null, name: 'Dev', email: 'dev@io', isActive: true },
};
const projects: Record<string, any> = {
  [PROJ_A]: { id: PROJ_A, name: 'proj-a' },
  [PROJ_B]: { id: PROJ_B, name: 'proj-b' },
};
// uid-dev is a developer member of project A only
const members = [{ projectId: PROJ_A, userId: 'uid-dev', role: 'developer' }];
const files = new Map<string, any>();

const repos: Record<string, any> = {
  User: { findOne: jest.fn(async ({ where }: any) => users[where.id] || null) },
  Project: {
    findOne: jest.fn(async ({ where }: any) =>
      (where.id && projects[where.id]) || Object.values(projects).find((p: any) => p.name === where.name) || null),
  },
  ProjectMember: {
    findOne: jest.fn(async ({ where }: any) =>
      members.find((m) => m.projectId === where.projectId && m.userId === where.userId) || null),
  },
  SdkCredential: {
    findOne: jest.fn(async ({ where }: any) =>
      where.token === SDK_TOKEN_A && where.status === 'active'
        ? { id: 'c1', token: SDK_TOKEN_A, projectId: PROJ_A, status: 'active' }
        : null),
  },
  File: {
    create: jest.fn((d: any) => ({ isDeleted: false, ...d })),
    save: jest.fn(async (f: any) => { files.set(f.id, f); return f; }),
    findOne: jest.fn(async ({ where }: any) => files.get(where.id) || null),
    find: jest.fn(async () => []),
  },
};

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: (e: any) => repos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null) },
  })),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import storageRouter, { UPLOADS_DIR, containedUploadPath, sanitizeDisplayName } from '../../../src/routes/storage';

const JWT_SECRET = 'storage-test-jwt-secret-0123456789abcdef';
const sign = (id: string) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  app = express();
  app.use(express.json());
  app.use('/api', storageRouter);
});

const createdPaths: string[] = [];
afterAll(() => {
  for (const p of createdPaths) { try { fs.unlinkSync(p); } catch {} }
});

describe('storage helpers', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\win.ini', 'win.ini'],
    ['..', 'file'],
    ['a/b/../../c.txt', 'c.txt'],
    ['evil\u0000.png', 'evil.png'],
    ['', 'file'],
  ])('sanitizeDisplayName(%j) -> %j', (input, expected) => {
    expect(sanitizeDisplayName(input)).toBe(expected);
  });

  it('containedUploadPath rejects names that escape the uploads directory', () => {
    expect(containedUploadPath('../outside')).toBeNull();
    expect(containedUploadPath('x/../../outside')).toBeNull();
    expect(containedUploadPath('sub/dir/file')).toBeNull();
    expect(containedUploadPath(path.resolve('/tmp/abs'))).toBeNull();
    expect(containedUploadPath('ok-file')).toBe(path.join(UPLOADS_DIR, 'ok-file'));
  });
});

describe('storage routes require authentication', () => {
  it.each([
    ['post', '/api/storage/upload-url'],
    ['put', `/api/storage/upload-raw/${PROJ_A}`],
    ['post', '/api/storage/confirm'],
    ['post', '/api/storage/delete'],
    ['get', `/api/storage/file/${PROJ_A}`],
    ['get', `/api/storage/project/${PROJ_A}`],
    ['get', `/api/storage/analytics/${PROJ_A}`],
  ])('%s %s -> 401 without credentials', async (method, url) => {
    const r = await (request(app) as any)[method](url).send({});
    expect(r.status).toBe(401);
  });

  it('rejects the legacy unverified sdk-{id}:{secret} token', async () => {
    const r = await request(app).post('/api/storage/upload-url')
      .set('Authorization', `Bearer sdk-${PROJ_A}:x`).send({ projectId: PROJ_A, fileName: 'a.txt' });
    expect(r.status).toBe(401);
  });
});

describe('storage project membership', () => {
  it('developer cannot register an upload in a project they are not a member of', async () => {
    const r = await request(app).post('/api/storage/upload-url')
      .set('Authorization', `Bearer ${sign('uid-dev')}`).send({ projectId: PROJ_B, fileName: 'a.txt' });
    expect(r.status).toBe(403);
  });

  it('SDK token for project A cannot register uploads for project B', async () => {
    const r = await request(app).post('/api/storage/upload-url')
      .set('Authorization', `Bearer ${SDK_TOKEN_A}`).send({ projectId: PROJ_B, fileName: 'a.txt' });
    expect(r.status).toBe(403);
  });

  it('non-member cannot read or delete another project\'s file', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    files.set(id, { id, projectId: PROJ_B, originalName: 'x.txt', isDeleted: false });
    const g = await request(app).get(`/api/storage/file/${id}`).set('Authorization', `Bearer ${sign('uid-dev')}`);
    expect(g.status).toBe(403);
    const d = await request(app).post('/api/storage/delete')
      .set('Authorization', `Bearer ${sign('uid-dev')}`).send({ fileId: id });
    expect(d.status).toBe(403);
    expect(files.get(id).isDeleted).toBe(false);
  });

  it('non-member cannot list another project\'s files', async () => {
    const r = await request(app).get(`/api/storage/project/${PROJ_B}`).set('Authorization', `Bearer ${sign('uid-dev')}`);
    expect(r.status).toBe(403);
  });
});

describe('storage path traversal', () => {
  it('a traversal file name is stored only as a display name; the physical file is the server UUID', async () => {
    const reg = await request(app).post('/api/storage/upload-url')
      .set('Authorization', `Bearer ${sign('uid-dev')}`)
      .send({ projectId: PROJ_A, fileName: '../../../../escape-test.txt' });
    expect(reg.status).toBe(201);
    const { fileId } = reg.body;
    const rec = files.get(fileId);
    expect(rec.originalName).toBe('escape-test.txt');
    expect(rec.storageKey).toBe(`${PROJ_A}/${fileId}`);
    expect(rec.uploadedById).toBe('uid-dev');

    const up = await request(app).put(`/api/storage/upload-raw/${fileId}`)
      .set('Authorization', `Bearer ${sign('uid-dev')}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('hello'));
    expect(up.status).toBe(200);
    const physical = path.join(UPLOADS_DIR, fileId);
    createdPaths.push(physical);
    expect(fs.existsSync(physical)).toBe(true);
    expect(fs.existsSync(path.resolve(UPLOADS_DIR, '../../../../escape-test.txt'))).toBe(false);
  });

  it('a legacy record whose originalName contains traversal is never resolved outside uploads', async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    // Plant a file outside the uploads dir that the old `${id}-${originalName}` join would have reached.
    const outside = path.resolve(UPLOADS_DIR, '..', `${id}-planted.txt`);
    fs.writeFileSync(outside, 'secret');
    createdPaths.push(outside);
    files.set(id, { id, projectId: PROJ_A, originalName: `x/../../${id}-planted.txt`, isDeleted: false });
    const r = await request(app).get(`/api/storage/file/${id}`).set('Authorization', `Bearer ${sign('uid-dev')}`);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('secret');
  });

  it('rejects non-UUID file ids', async () => {
    const r = await request(app).get('/api/storage/file/..%2F..%2Fetc%2Fpasswd')
      .set('Authorization', `Bearer ${sign('uid-devops')}`);
    expect(r.status).toBe(404);
  });
});
