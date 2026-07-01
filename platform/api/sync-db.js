require('dotenv').config();
require('reflect-metadata');
// Import the compiled DataSource and User entity from the dist folder
const { AppDataSource } = require('./dist/config/database');
const { User } = require('./dist/entities/User');

async function main() {
  try {
    console.log('Initializing database and synchronizing schema...');
    // Initialize the TypeORM DataSource (synchronize: true is enabled in development)
    await AppDataSource.initialize();
    console.log('Database connected and schema synchronized successfully!');

    const userRepo = AppDataSource.getRepository(User);
    const count = await userRepo.count();
    if (count === 0) {
      console.log('Seeding demo users...');
      const demoUsers = [
        userRepo.create({
          id: '11111111-1111-1111-1111-111111111111',
          name: 'John Dev',
          email: 'john@@dev.io',
          role: 'developer',
        }),
        userRepo.create({
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Sarah Lead',
          email: 'sarah@@dev.io',
          role: 'tech_lead',
        }),
        userRepo.create({
          id: '33333333-3333-3333-3333-333333333333',
          name: 'DevOps Boss',
          email: 'devops@@dev.io',
          role: 'devops',
        }),
      ];
      await userRepo.save(demoUsers);
      console.log('Demo users seeded successfully!');
    } else {
      console.log('Demo users already exist.');
    }
  } catch (err) {
    console.error('Database Sync Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
