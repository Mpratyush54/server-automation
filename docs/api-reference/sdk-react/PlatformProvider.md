# PlatformProvider

React context provider that makes the Platform API client and configuration available to all child components.

---

## Installation

```bash
npm install @mpratyush54/sdk-react
```

Requires **React >= 18**.

---

## Import

```tsx
import { PlatformProvider } from '@mpratyush54/sdk-react';
```

---

## Props

```typescript
interface PlatformProviderProps {
  config: PlatformConfig;
  children: ReactNode;
}
```

### `PlatformConfig`

| Prop | Type | Description |
|---|---|---|
| `apiBase` | `string` | **Required.** Platform API base URL (e.g. `https://platform.example.com`) |
| `token` | `string` | **Required.** SDK bearer token for API authentication |
| `projectId` | `string` | **Required.** Your Platform project ID |
| `environment?` | `string` | Deployment environment label (defaults to `'production'` in metric reports) |
| `appName?` | `string` | Optional application name |

---

## Behaviour

1. Creates an Axios instance pre-configured with `apiBase` as `baseURL` and the `token` in the `Authorization` header.
2. Installs request/response interceptors that **automatically measure HTTP call latency** and report metrics to `POST /api/sdk/api-metrics` (route, method, status code, duration).
3. Provides the API client and config through React context.

---

## Full Example

```tsx
import { PlatformProvider, usePlatform } from '@mpratyush54/sdk-react';

function App() {
  return (
    <PlatformProvider
      config={{
        apiBase: 'https://platform.example.com',
        token: process.env.NEXT_PUBLIC_PLATFORM_TOKEN!,
        projectId: 'my-project',
        environment: 'production',
      }}
    >
      <Dashboard />
    </PlatformProvider>
  );
}

function Dashboard() {
  const { config, api } = usePlatform();

  const fetchData = async () => {
    const { data } = await api.get('/api/sdk/config');
    console.log('Remote config:', data);
  };

  return (
    <div>
      <h1>Project: {config.projectId}</h1>
      <button onClick={fetchData}>Load Config</button>
    </div>
  );
}

export default App;
```

---

## Error Handling

- Metric reporting failures are **silent** — a `.catch(() => {})` is attached to every metrics POST.
- The provider does not throw; any API error from a consumer's `api.get()` call is returned normally as a rejected promise.
