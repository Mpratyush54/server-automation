import 'dotenv/config';
import 'reflect-metadata';
import { getDb } from './src/config/database';
import { User } from './src/entities/User';
import { runPendingMigrations } from './src/lib/migrations';
import { configuredAdminEmail, ensureAdminUser } from './src/lib/seed-admin';

async function main() {
  try {
    console.log('Initializing database and applying migrations...');
    const ds = await getDb();
    const applied = await runPendingMigrations(ds);
    console.log(`Database connected; applied ${applied.length} migration(s).`);

    const userRepo = ds.getRepository(User);
    const seeded = await ensureAdminUser(userRepo);
    if (seeded.created) {
      console.log(`Created admin ${configuredAdminEmail()}`);
    } else {
      console.log(`Admin already present: ${configuredAdminEmail()}`);
    }
    if (seeded.removedDemo > 0) {
      console.log(`Removed ${seeded.removedDemo} leftover demo user(s)`);
    }
  } catch (err: any) {
    console.error('Database Sync Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
