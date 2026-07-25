# API Seed — "Failed to obtain auth token for seeding"

## Symptom

> During bootstrap, the seeding script fails with:
> `Failed to obtain auth token for seeding`

## Root Cause

The API server has not finished starting up when the seeding script attempts to call its authentication endpoint. The API pods may still be in a `Running` state but the application inside is not yet ready to accept connections — the readiness probe has not passed, or the database migration has not completed.

## Fix

### Add a readiness wait loop before seeding

Use `kubectl wait` to block until the API deployment is fully ready:

```bash
kubectl wait --for=condition=Available deployment/api -n <namespace> --timeout=300s
```

Then add a short sleep for application-level readiness:

```bash
sleep 10
```

### Full seeding workflow

```bash
# 1. Wait for the API deployment to be available
kubectl wait --for=condition=Available deployment/api-deployment -n <namespace> --timeout=300s

# 2. Optional: wait for the pod's ready condition
kubectl wait --for=condition=Ready pod -l app=api -n <namespace> --timeout=300s

# 3. Give the application a moment to finish migrations
sleep 10

# 4. Run the seeding script
./seed.sh
```

### Alternatively, add retry logic to the seeding script

```bash
#!/usr/bin/env bash
MAX_RETRIES=10
RETRY_DELAY=15

for i in $(seq 1 $MAX_RETRIES); do
  echo "Attempt $i of $MAX_RETRIES..."
  if curl -s -f -X POST "$API_URL/auth/login" -d '{"username":"admin","password":"admin"}'; then
    echo "API ready — running seed..."
    # seed logic here
    exit 0
  fi
  echo "API not ready, retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

echo "Failed to reach API after $MAX_RETRIES attempts"
exit 1
```

## Verification

```bash
kubectl logs -l app=api -n <namespace> --tail=20
```

Expected output — the API server logs show that it has started, migrations have completed, and it is listening on its port. The seeding script should complete successfully with no auth token errors.
