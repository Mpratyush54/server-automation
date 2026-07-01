# usePlatform

React hook that returns the Platform context value. Must be used inside a `<PlatformProvider>`.

---

## Import

```tsx
import { usePlatform } from '@mpratyush54/sdk-react';
```

---

## Return Value

```typescript
interface PlatformContextValue {
  config: PlatformConfig;
  api: AxiosInstance;
}
```

| Field | Type | Description |
|---|---|---|
| `config` | `PlatformConfig` | The config object passed to `PlatformProvider` |
| `api` | `AxiosInstance` | Pre-configured Axios instance (base URL + bearer token) |

### `PlatformConfig`

```typescript
interface PlatformConfig {
  apiBase: string;
  token: string;
  projectId: string;
  environment?: string;
  appName?: string;
}
```

---

## Full Example

```tsx
import { PlatformProvider, usePlatform } from '@mpratyush54/sdk-react';

function App() {
  return (
    <PlatformProvider
      config={{
        apiBase: 'https://platform.example.com',
        token: 'sk-xxxx',
        projectId: 'my-app',
      }}
    >
      <MyComponent />
    </PlatformProvider>
  );
}

function MyComponent() {
  const { config, api } = usePlatform();

  return (
    <div>
      <p>Project: {config.projectId}</p>
      <p>Environment: {config.environment ?? 'production'}</p>
    </div>
  );
}
```

---

## Error Handling

- Throws `'usePlatform must be used within <PlatformProvider>'` if no `<PlatformProvider>` ancestor exists.
