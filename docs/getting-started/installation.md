# Installation

Set up Platform for local development in a few minutes.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >= 18 | API and SDK development |
| npm | >= 9 | Package management |
| Angular CLI | >= 19 | Portal development |
| PostgreSQL | >= 14 | Primary database |
| MongoDB | >= 7 | Logs, metrics, events |
| Redis | >= 7 | Caching and pub/sub |
| Docker | >= 24 | Container builds (optional for local) |
| k3s / kubectl | >= 1.28 | Kubernetes (production only) |

## 1. Clone the Repository

```bash
git clone https://github.com/your-org/platform.git
cd platform
```

## 2. Set Up PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE USER plat WITH PASSWORD 'plat' SUPERUSER;"
psql postgres -c "CREATE DATABASE plat_platform OWNER plat;"

# Ubuntu/Debian
sudo apt install postgresql
sudo systemctl start postgresql
sudo -u postgres psql -c "CREATE USER plat WITH PASSWORD 'plat' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE plat_platform OWNER plat;"

# Windows (assumes PostgreSQL installed via installer)
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE USER plat WITH PASSWORD 'plat' SUPERUSER;"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE plat_platform OWNER plat;"
```

## 3. Set Up MongoDB

```bash
# macOS
brew install mongodb-community@7
brew services start mongodb-community@7

# Ubuntu
sudo apt install -y mongodb-org
sudo systemctl start mongod

# Windows (assumes MongoDB installed)
net start MongoDB
```

## 4. Set Up Redis

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu
sudo apt install redis-server
sudo systemctl start redis-server

# Windows (assumes Redis installed via MSI)
net start Redis
```

## 5. Configure Environment

Create `platform/api/.env`:

```bash
# Server
PORT=3000
DOMAIN=localhost:3000
PORTAL_URL=http://localhost:4200

# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=plat
POSTGRES_PASSWORD=plat
POSTGRES_DB=plat_platform

# MongoDB
MONGO_URI=mongodb://localhost:27017/platform

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Secrets Encryption (32 bytes hex — generate with: openssl rand -hex 32)
SECRETS_ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# JWT
JWT_SECRET=plat-super-secret-key

# SMTP (optional — for email notifications)
SMTP_HOST=
SMTP_USER=
SMTP_PASS=

# MinIO / S3 (optional — for file storage)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=platform-files
S3_REGION=us-east-1
```

## 6. Start the API

```bash
cd platform/api
npm install
npm run dev
```

The API starts on `http://localhost:3000`. It auto-creates database tables and seeds demo users (John Dev, Sarah Lead, DevOps Boss) on first startup.

## 7. Start the Portal

```bash
cd platform/portal
npm install
ng serve
```

The portal starts on `http://localhost:4200`.

## 8. Seed Admin User

```bash
curl http://localhost:3000/api/users/init-demo
```

## 9. Verify

Open `http://localhost:4200` and log in with any demo account:

| Email | Password (none — just click) |
|---|---|
| admin@dev.io | No password required |
| devops@dev.io | No password required |
| sarah@dev.io | No password required |
| john@dev.io | No password required |

## Docker Compose (Alternative)

> **Not yet available.** PostgreSQL, MongoDB, and Redis must be installed natively or run separately via Docker.

```bash
# Run databases with Docker
docker run -d --name postgres -e POSTGRES_USER=plat -e POSTGRES_PASSWORD=plat -e POSTGRES_DB=plat_platform -p 5432:5432 postgres:16
docker run -d --name mongo -p 27017:27017 mongo:7
docker run -d --name redis -p 6379:6379 redis:7
```
