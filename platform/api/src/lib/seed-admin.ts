import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { Repository } from 'typeorm';
import { User, UserRole } from '../entities/User';

/** Accounts created by the old multi-user demo seeder — never keep these unless they ARE the configured admin. */
const BUILTIN_DEMO_EMAILS = [
  'admin@pratyushes.dev',
  'john@pratyushes.dev',
  'sarah@pratyushes.dev',
  'devops@pratyushes.dev',
];

export function configuredAdminEmail(): string {
  return (process.env.ADMIN_EMAIL || 'admin@pratyushes.dev').trim().toLowerCase();
}

/**
 * Ensure exactly one bootstrap login exists: ADMIN_EMAIL + ADMIN_PASSWORD.
 * Does not create john/sarah/devops demo accounts.
 */
export async function ensureAdminUser(repo: Repository<User>): Promise<{ user: User; created: boolean; removedDemo: number }> {
  const email = configuredAdminEmail();
  const password = process.env.ADMIN_PASSWORD || 'Admin@123';
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  const username = (process.env.ADMIN_USERNAME || email.split('@')[0] || 'admin').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME || username || 'Admin').trim();

  let removedDemo = 0;
  for (const demoEmail of BUILTIN_DEMO_EMAILS) {
    if (demoEmail === email) continue;
    const extra = await repo.findOne({ where: { email: demoEmail } });
    if (!extra) continue;
    try {
      await repo.remove(extra);
      removedDemo += 1;
    } catch (err: any) {
      console.warn(`[seed-admin] could not remove leftover demo user ${demoEmail}: ${err?.message || err}`);
    }
  }

  let created = false;
  let user = await repo.findOne({ where: { email } });

  if (!user) {
    const passwordHash = await bcrypt.hash(password, 10);
    user = repo.create({
      id: uuidv4(),
      name,
      email,
      username,
      passwordHash,
      role: UserRole.ADMIN,
      isActive: true,
    });
    user = await repo.save(user);
    created = true;
  } else {
    let updated = false;
    if (!user.passwordHash) {
      user.passwordHash = await bcrypt.hash(password, 10);
      updated = true;
    }
    if (!user.username) {
      user.username = username;
      updated = true;
    }
    if (user.role !== UserRole.ADMIN) {
      user.role = UserRole.ADMIN;
      updated = true;
    }
    if (user.isActive === false) {
      user.isActive = true;
      updated = true;
    }
    if (updated) user = await repo.save(user);
  }

  return { user, created, removedDemo };
}
