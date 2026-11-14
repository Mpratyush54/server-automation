# Move an app from Caps to Cairn

This page helps you update an app that still uses the old Caps SDK packages so it works with the current Cairn SDKs. You change your app's code and settings; nothing changes in the portal, where SDK tokens are under your project's **Settings**, **SDK tokens**.

Cairn was first called Caps, and later Platform. Only the SDK packages and settings changed. The SDK classes still carry the Platform name (`PlatformClient`, `PlatformProvider`, `PlatformModule`).

## Steps

1. Swap the packages:

   ```bash
   npm uninstall @caps/sdk-node @caps/sdk-react @caps/sdk-angular
   npm install @mpratyush54/sdk-node @mpratyush54/sdk-react @mpratyush54/sdk-angular
   ```

   For Python: `pip uninstall` the old package and `pip install mpratyush54-sdk`.

2. Change your code to the new names and options. Examples for each SDK are below.
3. Rename your settings: `CAPS_TOKEN` becomes `PLATFORM_SDK_TOKEN`. See the table below.
4. Start your app and check the project's **Monitoring** section in the portal for its logs and requests.

## Package names

| Old | New |
|---|---|
| `@caps/sdk-node` | `@mpratyush54/sdk-node` |
| `@caps/sdk-react` | `@mpratyush54/sdk-react` |
| `@caps/sdk-angular` | `@mpratyush54/sdk-angular` |
| `@caps/sdk-python` | `mpratyush54-sdk` (import `platform_sdk`) |

## Code changes

### Node.js

```typescript
// Old
import { CapsClient } from '@caps/sdk-node';

// New: the package exports a ready-made client
import platform from '@mpratyush54/sdk-node';

await platform.init({
  projectName: 'my-api',
  platformUrl: process.env.PLATFORM_URL,
  sdkToken: process.env.PLATFORM_SDK_TOKEN,
});
```

### React

```tsx
// Old
import { CapsProvider, useCaps } from '@caps/sdk-react';

// New
import { PlatformProvider, usePlatform } from '@mpratyush54/sdk-react';

<PlatformProvider config={{ apiBase: 'https://platform.example.com', token: 'sdk_live_...', projectId: '<project id>' }}>
  <App />
</PlatformProvider>
```

### Angular

```typescript
// Old
import { CapsModule } from '@caps/sdk-angular';

// New
import { PlatformModule } from '@mpratyush54/sdk-angular';

PlatformModule.forRoot({ apiBase: 'https://platform.example.com', token: 'sdk_live_...', projectId: '<project id>' });
```

### Python

```python
# Old
from caps_sdk import CapsClient

# New
import os
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name="my-service",
    platform_url=os.environ["PLATFORM_URL"],
    sdk_token=os.environ["PLATFORM_SDK_TOKEN"],
)
```

## Find and replace

| Find | Replace |
|---|---|
| `CapsClient` | `PlatformClient` (Node: the default export `platform`) |
| `CapsProvider` | `PlatformProvider` |
| `CapsModule` | `PlatformModule` |
| `useCaps` | `usePlatform` |
| `capsToken` | `sdkToken` (Node) or `token` (React, Angular) |
| `caps_token` | `sdk_token` |

## Settings

| Old | New | Read by |
|---|---|---|
| `CAPS_TOKEN` | `PLATFORM_SDK_TOKEN` | Node.js and Python SDKs, when you do not pass a token |
| `CAPS_API_URL` | `PLATFORM_URL` | The quickstarts pass it to `init`; the Node.js preload reads it |
| `CAPS_ENVIRONMENT` | `PLATFORM_ENVIRONMENT` | The Node.js preload |
| `CAPS_PROJECT_ID` | none | React and Angular take `projectId` in their config |
| `CAPS_LOG_LEVEL` | none | No current SDK reads a log level setting |

## More help

- SDK reference: [Node.js PlatformClient](../api-reference/sdk-node/PlatformClient.md), [React](../getting-started/react-sdk-quickstart.md), [Angular](../getting-started/angular-sdk-quickstart.md), [Python](../getting-started/python-sdk-quickstart.md).
- Open an issue: [github.com/Mpratyush54/SERVER-automation/issues](https://github.com/Mpratyush54/SERVER-automation/issues).

## How it works

- The API has no compatibility layer for Caps names. It does not accept a `capsToken` field and sends no deprecation header. Apps must send the new SDK token as `Authorization: Bearer <token>`, which the new SDKs do.
- The Node.js SDK reads `PLATFORM_SDK_TOKEN` when `sdkToken` is not passed, and logs a warning when no token is set. The Python SDK does the same with `sdk_token`.
- The Node.js preload (`@mpratyush54/sdk-node/dist/register`) calls `init` from settings: `PLATFORM_PROJECT_NAME` (or `PROJECT_NAME`), `PLATFORM_ENVIRONMENT` (or `ENVIRONMENT_NAME`), `PLATFORM_URL`, `APP_VERSION`, `GIT_SHA`.
- The old Caps package and variable names on this page come from earlier releases and could not be checked against current code.
