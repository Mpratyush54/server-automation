require('dotenv').config();
require('reflect-metadata');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { AppDataSource } = require('./dist/config/database');
const { User } = require('./dist/entities/User');

const DEMO_EMAILS = [
  'admin@pratyushes.dev',
  'john@pratyushes.dev',
  'sarah@pratyushes.dev',
  'devops@pratyushes.dev',
];

async function main() {
  try {
    console.log('Initializing database and synchronizing schema...');
    await AppDataSource.initialize();
    console.log('Database connected and schema synchronized successfully!');

    const userRepo = AppDataSource.getRepository(User);
    const email = (process.env.ADMIN_EMAIL || 'admin@pratyushes.dev').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'Admin@123';
    if (password.length < 8) {
      throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
    }
    const username = (process.env.ADMIN_USERNAME || email.split('@')[0] || 'admin').trim().toLowerCase();
    const name = (process.env.ADMIN_NAME || username || 'Admin').trim();

    let user = await userRepo.findOne({ where: { email } });
    if (!user) {
      user = userRepo.create({
        id: uuidv4(),
        name,
        email,
        username,
        passwordHash: bcrypt.hashSync(password, 10),
        role: 'admin',
        isActive: true,
      });
      await userRepo.save(user);
      console.log(`Created admin ${email}`);
    } else {
      console.log(`Admin already present: ${email}`);
    }

    for (const demoEmail of DEMO_EMAILS) {
      if (demoEmail === email) continue;
      const extra = await userRepo.findOne({ where: { email: demoEmail } });
      if (extra) {
        await userRepo.remove(extra);
        console.log(`Removed leftover demo user ${demoEmail}`);
      }
    }
  } catch (err) {
    console.error('Database Sync Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
