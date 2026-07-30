import 'dotenv/config';
import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { getDb } from './src/config/database';
import { User, UserRole } from './src/entities/User';

async function main() {
  try {
    console.log('Initializing database and synchronizing schema...');
    // getDb() initializes AppDataSource which has synchronize: true in dev
    const ds = await getDb();
    console.log('Database connected and schema synchronized successfully!');

    const userRepo = ds.getRepository(User);
    const count = await userRepo.count();
    if (count === 0) {
      console.log('Seeding demo users...');
      const passwordHash = bcrypt.hashSync('password123', 10);
      const demoUsers = [
        userRepo.create({
          id: '11111111-1111-1111-1111-111111111111',
          name: 'John Dev',
          email: 'john@pratyushes.dev',
          role: UserRole.DEVELOPER,
          passwordHash,
        }),
        userRepo.create({
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Sarah Lead',
          email: 'sarah@pratyushes.dev',
          role: UserRole.TECH_LEAD,
          passwordHash,
        }),
        userRepo.create({
          id: '33333333-3333-3333-3333-333333333333',
          name: 'DevOps Boss',
          email: 'devops@pratyushes.dev',
          role: UserRole.DEVOPS,
          passwordHash,
        }),
      ];
      await userRepo.save(demoUsers);
      console.log('Demo users seeded successfully!');
    } else {
      console.log('Demo users already exist.');
    }
  } catch (err: any) {
    console.error('Database Sync Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
