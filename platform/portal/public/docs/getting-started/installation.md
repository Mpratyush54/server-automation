# Installation

Set up Platform for development or production in a few minutes.

## Local Development (Docker Compose)

If you only need the databases to work on the Node.js API or Angular Portal locally, you can use the lightweight Docker Compose setup.

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/platform.git
cd platform
```

### 2. Start Databases

```bash
docker compose up -d postgres mongodb redis
```

### 3. Configure Environment

Create `platform/api/.env`:

```env
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

# JWT
JWT_SECRET=dev-secret-change-in-production
```

### 4. Start the API and Portal

```bash
cd platform/api
npm install
npm run dev

# In a new terminal:
cd platform/portal
npm install
npm start
```

---

## Server Installation (k3s / Portainer)

To deploy the full platform architecture (k3s, Portainer, Ingress, MinIO, and the API), use the included bootstrap scripts.

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/platform.git
cd platform
```

### 2. Run the Bootstrap Script

The `platform-bootstrap/bootstrap.sh` script is a fully automated, idempotent installer that provisions the entire Platform stack.

```bash
sudo ./platform-bootstrap/bootstrap.sh
```

**What this does in ~30 minutes:**
- Installs **Docker**, **k3s** (Kubernetes), and **Helm**.
- Deploys **nginx-ingress**, **Cert-Manager**, and **Portainer**.
- Provisions databases (PostgreSQL, MongoDB, Redis).
- Sets up **MinIO** for object storage and **Loki/Promtail** for logs.
- Builds and deploys the Platform API and Angular Portal into the cluster.

You can also run it non-interactively if you have an environment file ready:
```bash
NON_INTERACTIVE=true sudo ./platform-bootstrap/bootstrap.sh
```

### 3. Verify the Cluster

Check that the core services are running:

```bash
kubectl get nodes
kubectl get pods -n platform
```

For advanced configuration, environment variables, and scaling, see the [Bootstrap Deployment](../deployment/bootstrap.md) guide.

## 4. Log In

Open the deployed platform URL (or `http://localhost:4200` if local) and log in with the default admin credentials:
- **Email:** `admin@platform.local`
- **Password:** `admin123`

*(Change this immediately in production!)*

---

## Architecture Context

When running locally:
- SDK requests go to `http://localhost:3000`
- Portal talks to `http://localhost:3000`
- API writes to local Docker databases

When deploying to production, follow the [Bootstrap Deployment](../deployment/bootstrap.md) guide to provision the full Kubernetes cluster.
