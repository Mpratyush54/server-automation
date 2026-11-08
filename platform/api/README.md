# Platform API

Express + TypeORM (Postgres) + Mongoose (Mongo) backend for the platform portal,
SDKs and MCP server.

```bash
npm ci
npm run build
npm test
```

## Database schema and migrations

The Postgres schema is owned by versioned TypeORM migrations in
[`src/migrations/`](src/migrations/). The API never changes the schema on
boot (`synchronize` is off) and refuses to start while migrations are pending.

How migrations reach a server:

1. `platformctl provision` / `platformctl update` (and the digest auto-update
   CronJob) first back up the platform database with `pg_dump`
   (`/var/lib/platform/backups/<timestamp>/platform.dump`; the auto-update
   CronJob cannot reach the host, so it skips this step).
2. They run the `platform-api-migrate-<hash>` Kubernetes Job: the new API image
   running `node dist/migrate.js`. It holds a Postgres advisory lock, applies
   each pending migration in its own transaction, and exits non-zero on
   failure. The dump path is recorded in the Job's
   `platform.io/pre-migration-backup` annotation.
3. Only after the Job succeeds is the API Deployment rolled. A failed migration
   stops the rollout and the previous ReplicaSet keeps serving.

With `docker compose`, the `api-migrate` service plays the role of the Job.

### Adding a migration

1. Change the entity in `src/entities/` (register new entities in
   `src/config/database.ts`).
2. Get a local Postgres that is migrated to the current `master` schema:
   ```bash
   export POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=plat POSTGRES_PASSWORD=plat POSTGRES_DB=plat_dev
   npm run migration:run
   ```
3. Generate the migration from the entity diff, then read it:
   ```bash
   npm run migration:generate -- src/migrations/AddProjectDescription
   ```
   Review the SQL by hand. Keep it **expand/contract**: the previous API
   version must keep working against the new schema for one release, so the
   Deployment can be rolled back without reverting the schema. Add columns as
   nullable or with a default; rename or drop in a later release, once nothing
   reads the old name.
4. Apply and check:
   ```bash
   npm run migration:run     # applies pending migrations (same code as the Job)
   npm run migration:check   # exits 1 if entities and migrations still differ
   npm run migration:revert  # undoes the most recent migration (local only)
   ```
5. Commit the entity change and the migration together. The `API migrations`
   CI workflow applies every migration to an empty Postgres and fails if
   `migration:check` reports drift, so an entity change without a migration
   cannot merge.

Other scripts: `npm run migration:show` lists applied/pending migrations;
`npm run migration:create -- src/migrations/Name` creates an empty one for data
migrations that cannot be generated.

### The baseline (`InitialSchema`)

`1762560000000-InitialSchema` was generated from the entities when
`synchronize: true` was retired. Installs created by the old synchronize boot
path are adopted in place: every baseline statement runs in an idempotent form
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded enum types,
indexes and constraints), so existing tables and data are never changed and
only missing objects are added. The migrate Job logs any remaining difference
between the entities and the database as a warning. Never edit the baseline;
add a new migration instead. Reverting it drops all data and is refused unless
`ALLOW_BASELINE_REVERT=true`.

### Environment

| Variable | Purpose |
| --- | --- |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Connection used by the API, `migrate.js` and the TypeORM CLI |
| `MIGRATION_LOCK_TIMEOUT_MS` | How long `migrate.js` waits for another migrator's lock (default 10 min) |
| `DB_MIGRATE_ON_BOOT=true` | Local development only: apply pending migrations when the API starts instead of refusing to start |
| `MIGRATION_TEST_PG_*` | Enables `tests/integration/migrations.db.test.ts` against a real Postgres (`HOST`, `PORT`, `USER`, `PASSWORD`; needs `CREATEDB`) |
