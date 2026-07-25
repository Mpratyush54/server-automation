# Infisical pod crash-loops with `database "infisical" does not exist`

## Symptom

```
kubectl -n infisical logs deploy/infisical
error: database "infisical" does not exist
```

The pod restarts every 30 s in a `CrashLoopBackOff`.

## Root Cause

Infisical assumes its Postgres database already exists — the Bitnami Postgres
Helm chart only creates one initial database (`platform`), so Infisical's
`DB_CONNECTION_URI` points at a database that was never created.

The bootstrap creates the `infisical` database in Phase 14 by `psql`-ing into the
Postgres pod. Two ways that step gets skipped:

- The state file says `infisical=done` from a partial earlier run.
- Postgres was still coming up when Phase 14 ran, so the `CREATE DATABASE`
  command silently failed.

## Fix

### 1. Create the database manually

```bash
POSTGRES_PASSWORD=$(sudo grep '^POSTGRES_PASSWORD=' /etc/platform/.env | cut -d= -f2 | tr -d "'")

kubectl -n databases exec -i postgresql-0 -- \
  env PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -c "CREATE DATABASE infisical;"
```

Expected output: `CREATE DATABASE`. If it says `already exists`, that's fine — the
database is fine and the pod is failing for a different reason (check logs again).

### 2. Restart Infisical

```bash
kubectl -n infisical rollout restart deployment/infisical
kubectl -n infisical rollout status  deployment/infisical
```

### 3. Alternative — re-run the bootstrap phase

```bash
sudo sed -i '/^infisical=/d' /etc/platform/.bootstrap_state
sudo ./platform-bootstrap/bootstrap.sh
```

The Phase 14 handler is idempotent — it uses `SELECT 1 FROM pg_database` before
attempting the create.

## Verification

```bash
kubectl -n infisical logs deploy/infisical --tail=20
```

Expected: `Server listening on port 8080` with no database errors.
