# MongoDB — "auth.usernames, auth.databases — Both must be provided"

## Symptom

> Installing the Bitnami MongoDB Helm chart fails with:
> `auth.usernames, auth.databases — Both must be provided`

## Root Cause

The Helm chart validation requires both `auth.usernames` and `auth.databases` to be present. This error occurs when the YAML values are misformatted — for example, using a YAML list when the chart expects a comma-separated string, or omitting one of the two fields.

## Fix

### Option 1: Comma-separated strings (recommended)

```yaml
# values.yaml
auth:
  usernames: "user1,user2"
  databases: "db1,db2"
  passwords: "pass1,pass2"
```

### Option 2: YAML list format (also valid)

```yaml
# values.yaml
auth:
  usernames:
    - user1
    - user2
  databases:
    - db1
    - db2
  passwords:
    - pass1
    - pass2
```

> **Important**: The number of entries in `usernames`, `databases`, and `passwords` must match. Each user is granted access to the corresponding database at the same index.

### Option 3: `--set` flags

```bash
helm upgrade --install mongodb bitnami/mongodb \
  --namespace mongodb --create-namespace \
  --set auth.rootUser=admin \
  --set auth.rootPassword=rootpass \
  --set "auth.usernames={user1,user2}" \
  --set "auth.databases={db1,db2}" \
  --set "auth.passwords={pass1,pass2}"
```

## Verification

```bash
kubectl get pods -n mongodb -w
```

Wait for the pod to reach `Running` state. Verify user creation:

```bash
kubectl exec -it mongodb-0 -n mongodb -- mongosh \
  -u admin -p rootpass --authenticationDatabase admin \
  --eval "db.getUsers()"
```

Expected output — the created users are listed.
