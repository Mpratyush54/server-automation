# TypeScript — `TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'`

## Symptom

> TypeScript build error in `k8s.ts`:
> `TS2345: Argument of type 'V1Container' is not assignable to parameter of type 'V1Container'.`

or similar type mismatch involving `@kubernetes/client-node` types.

## Root Cause

TypeScript strict mode is enabled (`strict: true` in `tsconfig.json`). The `@kubernetes/client-node` library defines types that require exact property shapes. When passing a plain object literal (e.g., `{ name: "x", image: "y" }`) to a function expecting a `V1Container`, TypeScript's excess-property checking flags the mismatch — even though the object has all required properties.

## Fix

Add explicit type annotations when constructing Kubernetes API objects.

### Example from codebase

**Before** (produces TS2345):

```typescript
const container = {
  name: "my-container",
  image: "nginx:latest",
  ports: [{ containerPort: 80 }],
};

const podSpec: V1PodSpec = {
  containers: [container], // TS2345
  restartPolicy: "Always",
};
```

**After** (correct):

```typescript
import { V1Container, V1PodSpec } from "@kubernetes/client-node";

const container: V1Container = {
  name: "my-container",
  image: "nginx:latest",
  ports: [{ containerPort: 80 }],
};

const podSpec: V1PodSpec = {
  containers: [container],
  restartPolicy: "Always",
};
```

Alternatively, cast with `as V1Container`:

```typescript
const podSpec: V1PodSpec = {
  containers: [container as V1Container],
  restartPolicy: "Always",
};
```

> The safest approach is to declare the variable with the explicit type, which enables full IDE autocompletion and stricter validation.

## Verification

```bash
npx tsc --noEmit
```

Expected output — no `TS2345` errors.
