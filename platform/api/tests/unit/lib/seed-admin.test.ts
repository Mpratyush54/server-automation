import bcrypt from 'bcryptjs';
import { ensureAdminUser } from '../../../src/lib/seed-admin';

function makeRepo(existing: any = null) {
  return {
    findOne: jest.fn(async ({ where }: any) => (existing && where.email === existing.email ? existing : null)),
    create: jest.fn((d: any) => d),
    save: jest.fn(async (u: any) => u),
    remove: jest.fn(async () => undefined),
  } as any;
}

describe('ensureAdminUser (M1 — no default admin password)', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD };
    process.env.ADMIN_EMAIL = 'owner@example.com';
    delete process.env.ADMIN_PASSWORD;
  });
  afterAll(() => { process.env = OLD; });

  it('refuses to create the admin when ADMIN_PASSWORD is not set', async () => {
    const repo = makeRepo();
    await expect(ensureAdminUser(repo)).rejects.toThrow(/ADMIN_PASSWORD is not set/);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('refuses the published default "Admin@123"', async () => {
    process.env.ADMIN_PASSWORD = 'Admin@123';
    await expect(ensureAdminUser(makeRepo())).rejects.toThrow(/published default/);
  });

  it('creates the admin with the configured password', async () => {
    process.env.ADMIN_PASSWORD = 'a-unique-strong-password';
    const repo = makeRepo();
    const { user, created } = await ensureAdminUser(repo);
    expect(created).toBe(true);
    expect(await bcrypt.compare('a-unique-strong-password', user.passwordHash!)).toBe(true);
    expect(await bcrypt.compare('Admin@123', user.passwordHash!)).toBe(false);
  });

  it('leaves an existing admin with a real password alone when ADMIN_PASSWORD is unset', async () => {
    const existing = { email: 'owner@example.com', username: 'owner', role: 'admin', isActive: true, passwordHash: bcrypt.hashSync('their-own-pass', 4) };
    const repo = makeRepo(existing);
    const { created } = await ensureAdminUser(repo);
    expect(created).toBe(false);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rotates an existing admin that still has the published default password', async () => {
    process.env.ADMIN_PASSWORD = 'a-unique-strong-password';
    const existing = { email: 'owner@example.com', username: 'owner', role: 'admin', isActive: true, passwordHash: bcrypt.hashSync('Admin@123', 4) };
    const { user } = await ensureAdminUser(makeRepo(existing));
    expect(await bcrypt.compare('Admin@123', user.passwordHash!)).toBe(false);
  });
});
