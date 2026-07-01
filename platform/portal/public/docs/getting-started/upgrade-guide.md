# Upgrade Guide: Caps → Platform

Platform was originally branded as **Caps**. This guide helps you migrate from the old packages, imports, and environment variables to the current Platform naming.

## Package Renames

| Old Package | New Package |
|---|---|
| `@caps/sdk-node` | `@mpratyush54/sdk-node` |
| `@caps/sdk-python` | `platform-sdk-python` |
| `@caps/sdk-react` | `@mpratyush54/sdk-react` |
| `@caps/sdk-angular` | `@mpratyush54/sdk-angular` |

## Import Renames

### Node.js SDK

```typescript
// Old
import { CapsClient } from '@caps/sdk-node';
const client = new CapsClient({ apiUrl: '...', capsToken: '...' });

// New
import { PlatformClient } from '@mpratyush54/sdk-node';
const client = new PlatformClient({ apiUrl: '...', sdkToken: '...' });
```

### React SDK

```tsx
// Old
import { CapsProvider, useCaps } from '@caps/sdk-react';

// New
import { PlatformProvider, usePlatform } from '@mpratyush54/sdk-react';
```

### Angular SDK

```typescript
// Old
import { CapsModule } from '@caps/sdk-angular';
CapsModule.forRoot({ capsToken: '...' });

// New
import { PlatformModule } from '@mpratyush54/sdk-angular';
PlatformModule.forRoot({ sdkToken: '...' });
```

### Python SDK

```python
# Old
from caps_sdk import CapsClient
client = CapsClient(caps_token='...')

# New
from platform_sdk import PlatformClient
client = PlatformClient(sdk_token='...')
```

## Environment Variable Renames

| Old Variable | New Variable |
|---|---|
| `CAPS_API_URL` | `PLATFORM_API_URL` |
| `CAPS_TOKEN` | `PLATFORM_SDK_TOKEN` |
| `CAPS_PROJECT_ID` | `PLATFORM_PROJECT_ID` |
| `CAPS_ENVIRONMENT` | `PLATFORM_ENVIRONMENT` |
| `CAPS_LOG_LEVEL` | `PLATFORM_LOG_LEVEL` |

## Migration Steps

### 1. Update package.json

Replace all `@caps/*` dependencies with their Platform equivalents:

```bash
npm uninstall @caps/sdk-node @caps/sdk-react @caps/sdk-angular
npm install @mpratyush54/sdk-node @mpratyush54/sdk-react @mpratyush54/sdk-angular
```

### 2. Update Environment Variables

```bash
# Old .env
CAPS_API_URL=http://localhost:3000
CAPS_TOKEN=sdk_xxxxx

# New .env
PLATFORM_API_URL=http://localhost:3000
PLATFORM_SDK_TOKEN=sdk_xxxxx
```

### 3. Update Imports

Use your IDE's search-and-replace to rename imports across your codebase:

| Find | Replace |
|---|---|
| `CapsClient` | `PlatformClient` |
| `CapsProvider` | `PlatformProvider` |
| `CapsModule` | `PlatformModule` |
| `useCaps` | `usePlatform` |
| `capsToken` | `sdkToken` |
| `caps_token` | `sdk_token` |
| `CAPS_` | `PLATFORM_` |

### 4. Update Config Objects

```typescript
// Old
{ capsToken: 'sdk_xxxxx', capsProjectId: 'proj-xxxxx' }

// New
{ sdkToken: 'sdk_xxxxx', projectId: 'proj-xxxxx' }
```

## Backward Compatibility

The Platform API still accepts the old `capsToken` field in requests for a transition period. You will see a deprecation warning in the response headers:

```
Warning: 299 - "capsToken is deprecated, use sdkToken instead"
```

This compatibility layer will be removed in a future major release. Migrate as soon as possible.

## Verification

After migration, verify your application starts correctly:

```bash
# Run your app and check the startup log
node dist/index.js
# Expected: "PlatformClient initialized successfully"
# If you see "CapsClient is deprecated" — update your imports
```

## Need Help?

- Check the [SDK API References](../api-reference/sdk-node/PlatformClient.md) for updated configuration options
- Open an issue at [github.com/your-org/platform/issues](https://github.com/your-org/platform/issues)
