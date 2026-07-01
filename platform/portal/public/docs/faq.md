# FAQ

**Q: What databases does Platform support?**

A: PostgreSQL (primary), MongoDB (logs/metrics), Redis (caching). The API provisions all three on demand.

**Q: Do I need Kubernetes to use Platform?**

A: For local development, no — just PostgreSQL, MongoDB, and Redis. For production, k3s is required.

**Q: How does authentication work?**

A: Email-based JWT login (no password). Users log in by entering their email address. In production, OIDC/SSO is available.

**Q: Can I use Platform with my existing infrastructure?**

A: Yes. Platform is designed to be self-hosted on any Kubernetes cluster (k3s recommended for single-node).

**Q: What's the difference between preset roles and custom roles?**

A: Preset roles (admin, devops, tech_lead, developer, viewer) have fixed permissions. Custom roles allow fine-grained permission selection. Custom role permissions are merged with the user's preset role.

**Q: How are secrets encrypted?**

A: AES-256-GCM with a random IV per secret. The encryption key is set via `SECRETS_ENCRYPTION_KEY` env var (32 bytes hex).

**Q: How long do preview environments last?**

A: 72 hours by default. The PreviewDecayScheduler runs every hour and terminates expired previews.

**Q: Can I use my own SMTP server?**

A: Yes. Configure `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` in the environment.

**Q: What file storage options are available?**

A: MinIO (self-hosted S3-compatible) or any S3-compatible provider. Configure via `S3_ENDPOINT`, `S3_ACCESS_KEY`, etc.

**Q: How do I reset the database?**

A: Drop and recreate:

```sql
DROP DATABASE plat_platform;
CREATE DATABASE plat_platform OWNER plat;
```

Then restart the API (it auto-seeds).

**Q: What's the login format with `@@`?**

A: **Fixed** — all demo accounts now use single `@` (e.g., admin@dev.io). If you're on an older version, use double `@`.
