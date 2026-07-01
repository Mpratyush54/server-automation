# MinIO Helm — "key caps-logs has no value" template error

## Symptom

> Running `helm template` or `helm install` for MinIO fails with:
> `key caps-logs has no value` or similar "has no value" errors for other keys.

## Root Cause

The Helm values file contains template-variable syntax that Helm's Go templating engine attempts to evaluate. Helm interprets strings like `{{ .Values.something }}` as template directives. If the referenced key does not exist in the values context, Helm emits a "has no value" error.

This commonly happens when:
- A string like `{{ logs }}` or `{{ caps }}` is used literally (e.g., in a bucket name or annotation) and is misinterpreted as a template expression.
- The values file uses `{{ }}` delimiters intended for a different system (e.g., shell env substitution) but Helm tries to render them.

## Fix

### 1. Escape literal `{{ }}` in values

If you need a literal `{{` in your values (e.g., in an annotation or config string), escape it with quotes or use Helm's `{{ "{{" }}` directive.

Instead of:

```yaml
bucketName: "{{ logs }}-bucket"
```

Use:

```yaml
bucketName: '{{ "{{" }} logs }}-bucket'
```

Or better, avoid template delimiters entirely:

```yaml
bucketName: "logs-bucket"
```

### 2. Remove accidental template syntax

Scan your values file for unintended `{{ }}`:

```bash
rg '\{\{' values.yaml
```

If you find lines that contain template syntax where plain text was intended, replace them.

### 3. Validate with `--dry-run`

Before installing, always run a dry-run to catch template errors:

```bash
helm template minio bitnami/minio -f values.yaml > /dev/null
```

## Verification

```bash
helm template minio bitnami/minio -f values.yaml 2>&1
```

The output should render successfully — no "has no value" errors. Proceed with install:

```bash
helm upgrade --install minio bitnami/minio -f values.yaml --namespace minio
```
