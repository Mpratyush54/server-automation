# Installation

Set up Platform for development or production in a few minutes.

## Local Development (Docker Compose)

If you only need the databases to work on the Node.js API or Angular Portal locally, you can use the lightweight Docker Compose setup.

### 1. Clone the Repository

```bash
git clone https://github.com/Mpratyush54/SERVER-automation.git
cd SERVER-automation/platform
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
ng serve
```

### 5. Seed Demo Users

In a new terminal, seed the demo users and roles:

```bash
curl http://localhost:3000/api/users/init-demo
```

Or run the npm seed script:

```bash
cd platform/api && npm run seed:db
```

---

## Server Installation (k3s / Production)

To deploy the full platform architecture (k3s, Ingress, MinIO, ArgoCD, Grafana, and the API), use the included bootstrap script.

### 1. Clone the Repository on Your Server

```bash
git clone https://github.com/Mpratyush54/SERVER-automation.git
cd SERVER-automation/platform-bootstrap
```

### 2. Run the Bootstrap Script

The `bootstrap.sh` script is a fully automated, idempotent installer that provisions the entire Platform stack on a fresh Ubuntu 22.04+ server.

```bash
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

**What this does in ~30 minutes:**
- Installs **Docker**, **k3s** (Kubernetes), and **Helm 3**
- Deploys **nginx-ingress** and **cert-manager** for SSL termination
- Provisions databases: **PostgreSQL**, **MongoDB**, **Redis** (all in `databases` namespace)
- Sets up **MinIO** for backup object storage
- Deploys **Grafana + Prometheus + Loki** for observability
- Installs **ArgoCD** for GitOps continuous delivery
- Installs **Portainer** for container management
- Builds and deploys the **Platform API** and **Angular Portal** into the cluster
- Seeds the admin user and default configurations

You can also run it non-interactively:

```bash
PLATFORM_DOMAIN=148.113.58.205.sslip.io NON_INTERACTIVE=true sudo ./bootstrap.sh
```

### 3. Verify the Cluster

Check that the core services are running:

```bash
kubectl get nodes
kubectl get pods -n platform
kubectl get pods -n databases
```

For advanced configuration, environment variables, and scaling, see the [Bootstrap Deployment](../deployment/bootstrap.md) guide.

---

## Logging In

The Platform supports two login modes, accessible from the login page toggle:

### Mode 1 — Username + Password (Default)

Use this for the admin account and any user who has set a password.

| Name | Username | Email | Password | Role |
|---|---|---|---|---|
| Admin | `admin` | `admin@dev.io` | `Admin@123` | Admin |

> **⚠️ Change the admin password immediately in production** via Settings → Profile → Change Password.

### Mode 2 — Passwordless Email Login

Use this for developer/team accounts that don't have a password set. Simply enter the email address — no password required.

| Name | Email | Role |
|---|---|---|
| DevOps Boss | `devops@dev.io` | DevOps |
| Sarah Lead | `sarah@dev.io` | Tech Lead |
| John Dev | `john@dev.io` | Developer |

> These accounts are for **local development only**. In production, invite real team members via the Admin → Users panel.

---

## Architecture Context

When running locally:
- SDK requests go to `http://localhost:3000`
- Portal talks to `http://localhost:3000`
- API writes to local Docker databases

When deploying to production, follow the [Bootstrap Deployment](../deployment/bootstrap.md) guide to provision the full Kubernetes cluster.

**Production URL:** [https://148.113.58.205.sslip.io/](https://148.113.58.205.sslip.io/)
