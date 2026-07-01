# Installation

Set up Platform for local development in a few minutes.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >= 18 | API and SDK development |
| npm | >= 9 | Package management |
| Angular CLI | >= 19 | Portal development |
| Docker | >= 24 | Containerized databases and services |

---

## 1. Clone the Repository

```bash
git clone https://github.com/your-org/platform.git
cd platform
```

---

## 2. Start Databases with Docker Compose (Recommended)

The repo ships a fully configured `docker-compose.yml` at the root that starts all required services:

```bash
docker compose up -d postgres mongodb redis
```

This starts:
| Service | Port | Credentials |
|---|---|---|
| PostgreSQL 16 | 5432 | `platform` / `platform` / `platform` |
| MongoDB 7 | 27017 | No auth (local dev) |
| Redis 7 | 6379 | No password |

Optional services (start if needed):
```bash
docker compose up -d minio loki prometheus grafana
```

Verify they're running:
```bash
docker compose ps
```

---

## 3. Configure Environment

Create `platform/api/.env`:

```bash
# Server
NODE_ENV=development
PORT=3000
DOMAIN=localhost:3000
PORTAL_URL=http://localhost:4200

# PostgreSQL (matches docker-compose.yml defaults)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=platform
POSTGRES_PASSWORD=platform
POSTGRES_DB=platform

# MongoDB
MONGODB_URI=mongodb://localhost:27017/platform

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT (generate a real secret for production: openssl rand -hex 32)
JWT_SECRET=dev-secret-change-in-production

# Logging
LOKI_URL=http://localhost:3100
```

---

## 4. Start the API

```bash
cd platform/api
npm install
npm run dev
```

The API starts on `http://localhost:3000`. On first startup, database tables auto-sync and demo users are seeded.

---

## 5. Start the Portal

```bash
cd platform/portal
npm install
ng serve
```

The portal starts on `http://localhost:4200`.

---

## 6. Seed Admin User (if needed)

```bash
curl http://localhost:3000/api/users/init-demo
```

---

## 7. Verify

Open `http://localhost:4200` and log in with any demo account:

| Email | Password (none — just click sign in) |
|---|---|
| admin@dev.io | No password required |
| devops@dev.io | No password required |
| sarah@dev.io | No password required |
| john@dev.io | No password required |

---

## Manual Setup (Without Docker)

If you prefer to run databases natively:

### PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE USER platform WITH PASSWORD 'platform' SUPERUSER;"
psql postgres -c "CREATE DATABASE platform OWNER platform;"

# Ubuntu/Debian
sudo apt install postgresql
sudo systemctl start postgresql
sudo -u postgres psql -c "CREATE USER platform WITH PASSWORD 'platform' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE platform OWNER platform;"

# Windows (assumes PostgreSQL installed via installer)
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE USER platform WITH PASSWORD 'platform' SUPERUSER;"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE platform OWNER platform;"
```

### MongoDB

```bash
# macOS
brew install mongodb-community@7
brew services start mongodb-community@7

# Ubuntu
sudo apt install -y mongodb-org
sudo systemctl start mongod

# Windows
net start MongoDB
```

### Redis

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu
sudo apt install redis-server
sudo systemctl start redis-server

# Windows
net start Redis
```
