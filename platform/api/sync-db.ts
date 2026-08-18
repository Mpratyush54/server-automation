import 'dotenv/config';
import 'reflect-metadata';
import { getDb } from './src/config/database';
import { User } from './src/entities/User';
import { configuredAdminEmail, ensureAdminUser } from './src/lib/seed-admin';

async function main() {
  try {
    console.log('Initializing database and synchronizing schema...');
    const ds = await getDb();
    console.log('Database connected and schema synchronized successfully!');

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
