# FAQ

**Q: What databases does Platform use?**

PostgreSQL (primary — projects, users, permissions, secrets metadata), MongoDB
(logs, metrics, deployment events, audit trail), Redis (sessions and cache). The
API provisions all three on-demand for user projects.

---

**Q: Do I need Kubernetes to use Platform?**

Not for local development — just Postgres, Mongo and Redis (Docker Compose is fine).
For production, k3s (or any Kubernetes cluster) is required. The bootstrap installs
k3s automatically.

---

**Q: How does authentication work?**

Passwordless email-based JWT. Users enter their email and get a token — no password
prompt anywhere in the flow. In production you can add OIDC/SSO from Settings →
Authentication, and the Platform ships oauth2-proxy on-cluster so services that
don't ship SSO in their OSS build (Portainer, MinIO, Infisical) can still sit
behind the same single sign-on.

---

**Q: Where's the admin password?**

There isn't one. The seeded admin is `admin@pratyushes.dev` and you sign in by typing that
email — no password to remember, no default to change. If you want to lock the
account down, add an OIDC provider and disable email-only auth in Settings.

---

**Q: Can I use Platform with my existing Kubernetes cluster?**

Yes. Run the bootstrap with `SKIP_K8S=true` — it will use your existing `kubectl`
context instead of installing k3s.

---

**Q: What's the difference between preset roles and custom roles?**

Preset roles (`admin`, `devops`, `tech_lead`, `developer`, `viewer`) have fixed
permission sets. Custom roles let you pick individual permissions. When a user has
both, the effective permissions are the union of the preset role and the custom
role.

---

**Q: How are secrets encrypted?**

AES-256-GCM with a random IV per secret. The master key is the `SECRETS_ENCRYPTION_KEY`
env var (32 bytes hex — generate with `openssl rand -hex 32`). See
[architecture/secrets-architecture.md](architecture/secrets-architecture.md).

---

**Q: How long do preview environments last?**

72 hours by default. The `PreviewDecayScheduler` runs every hour and terminates
expired previews. Preview URLs follow the format
`https://{project-slug}-{sanitized-branch}.preview.{DOMAIN}`.

---

**Q: Can I use my own SMTP server?**

Yes — pick "Custom SMTP" during bootstrap or configure `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS` in the environment. AWS SES, SendGrid and Mailgun are also first-class
options and get their own prompts.

---

**Q: What file storage options are available?**

Bundled MinIO (installed by the bootstrap) or any S3-compatible provider (real
AWS S3, Cloudflare R2, Backblaze B2). Configure via the bootstrap's Backup Storage
prompt or via the `EXT_S3_*` env vars.

---

**Q: Do I need Infisical?**

No — Platform's own secrets engine (AES-256-GCM with versioning, rollback and
audit trail) covers everything Infisical does for a single-cluster setup. Infisical
is installed by the bootstrap as an *optional* integration for teams already using
it. If you're new, skip it.

---

**Q: How do I reset the database in local dev?**

```sql
DROP DATABASE platform;
CREATE DATABASE platform OWNER platform;
```

Then restart the API — it auto-syncs schema and re-seeds demo users.

---

**Q: The portal says "User email not found. Run init-demo first." — what do I do?**

The auto-seed didn't run (usually because the API started before Postgres was
healthy). Run:

```bash
npm --prefix platform/api run seed:db
```

---

**Q: Something in the bootstrap failed halfway. Do I have to start over?**

No — the script is idempotent. Just re-run `sudo ./bootstrap.sh` and it resumes
from the failed phase. Completion state lives in `/etc/platform/.bootstrap_state`.

---

**Q: Where do I find generated credentials after a server install?**

`/etc/platform/.env` (mode 600, root only). Back it up immediately — losing it
means losing access to Postgres, Mongo, Redis, MinIO, ArgoCD, Grafana and
Portainer's local admin.
