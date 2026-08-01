# SDK examples index

Runnable and copy-paste examples for every official SDK, plus the multi-app cluster demo.

## Packages

| SDK | Package | Package examples | Quickstart |
|-----|---------|------------------|------------|
| Node.js | `@mpratyush54/sdk-node` | [`sdk-node/examples`](../../sdk-node/examples) | [Node quickstart](node-sdk-quickstart.md) |
| React | `@mpratyush54/sdk-react` | [`sdk-react/examples`](../../sdk-react/examples) | [React quickstart](react-sdk-quickstart.md) |
| Angular | `@mpratyush54/sdk-angular` | [`sdk-angular/examples`](../../sdk-angular/examples) | [Angular quickstart](angular-sdk-quickstart.md) |
| Python | `mpratyush54-sdk` | [`sdk-python/examples`](../../sdk-python/examples) | [Python quickstart](python-sdk-quickstart.md) |

## Cluster demo (Node + React + Angular)

[`examples/sdk-apps`](../../examples/sdk-apps) registers via the Node SDK, ensures Postgres/Mongo/Redis, serves React and Angular UIs, and ships telemetry to the portal.

```powershell
cd examples/sdk-apps
$env:PLATFORM_SDK_TOKEN='sdk_live_...'
./start-demos.ps1
```

## Common prerequisites

1. Create a **project** in the portal.
2. Create an **SDK token** (Project → Tokens).
3. Set `PLATFORM_URL` / `PLATFORM_SDK_TOKEN` (and project id where required).
4. For GitOps demos, set the project **repository URL** to the same git remote the SDK sends.

## Publishing

CI publishes SDKs from [`.github/workflows/publish-packages.yml`](../../.github/workflows/publish-packages.yml) using npm Trusted Publishers + PyPI OIDC. See [SDK publishing](../deployment/sdk-publishing.md) if present in your docs tree.
