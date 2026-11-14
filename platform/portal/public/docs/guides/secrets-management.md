# Store secrets and settings for your app

This page helps you keep API keys, passwords and other settings in Cairn instead of in your code. Open your project and go to **Configuration**. The **Variables** list there holds both plain settings and encrypted secrets.

## Add a secret

1. Open the project and go to **Configuration**.
2. Choose **Add variable**.
3. Enter a key, for example `STRIPE_API_KEY`, and the value.
4. Pick a scope: **Global (all environments)** or one environment, such as production.
5. Tick **Encrypt as secret** and save.

Without **Encrypt as secret** the value is stored as a plain setting, which anyone on the project can read. Use plain settings for things like `API_URL`, and secrets for anything private.

Keys may use letters, digits, `_`, `.` and `-`, and must start with a letter or `_`.

## Read the value in your app

Your app reads variables through the Cairn SDK, using a server SDK token from the project's **Settings > SDK tokens**.

```js
import platform from '@mpratyush54/sdk-node';

await platform.init({
  projectName: 'my-api',
  platformUrl: process.env.PLATFORM_URL,
  sdkToken: process.env.PLATFORM_SDK_TOKEN,
  environmentName: 'production',
});

const stripeKey = platform.config('STRIPE_API_KEY');
```

The SDK loads all variables at startup and refreshes them every 30 seconds, so a changed value reaches the app without a restart. The app gets the global variables plus the ones for its own environment.

## See, change or undo a secret

- **See a value:** choose **Reveal** on the row. You are asked for a fresh two-factor code. See [Two-factor sign-in](mfa.md).
- **Change a value:** choose **Edit**, enter the new value and save. Leave the value empty to keep the current one.
- **Undo a change:** choose **History** on the row, then **Rollback** on the version you want. The rollback is saved as a new version, so you can undo it too.
- **Delete:** choose **Delete** on the row.

## Add many at once

Choose **Paste .env** and paste `KEY=VALUE` lines. Tick **Secret** for the lines that should be encrypted, then choose **Import**.

To copy all secrets of one environment out, choose **Export secrets**. You are asked for a fresh two-factor code.

## Who can do what

| Action | Needs |
|---|---|
| See keys | Any project member |
| Read plain values | Developer or higher on the project (`config.read`) |
| Add or change plain settings | `config.update` (tech lead, DevOps, admin) |
| Add or change secrets | `secrets.create` (tech lead, DevOps, admin) |
| Reveal or export secrets | `secrets.reveal` or `secrets.export`, plus a fresh two-factor code |
| Roll back a secret | `secrets.rollback` (DevOps, admin) |

Viewers see keys and types only. See [Permissions](../api-reference/configuration/permissions.md).

## How it works

- Secrets are encrypted on the server with AES-256-GCM before they are saved. The key is derived (SHA-256) from `SECRETS_ENCRYPTION_KEY`. The stored form is `iv:authTag:ciphertext`. The plain value is never saved. See [Secrets encryption](../api-reference/configuration/secrets-encryption.md).
- Plain settings are stored in the project configuration table. Secrets are stored in a separate `secrets` table in PostgreSQL. The **Variables** list shows both, merged. Turning a plain setting into a secret moves it to the encrypted store and removes the plain copy. Turning a secret into a plain setting needs `secrets.delete`, `secrets.reveal` and a fresh two-factor code.
- Every change to a secret saves the previous encrypted value to `secret_versions` first. A rollback copies an old version back and increases the version number. For example, if the current version is 5 and you roll back to 3, version 3's value becomes version 6.
- Deleting a secret is a soft delete: it is marked inactive.
- A global secret (no environment) is returned for every environment. A secret scoped to an environment is returned only for that environment.
- Only **server** SDK tokens can read variables. Browser tokens cannot. A token can only read its own project. Cairn's own credentials are never sent to the SDK, even if they were copied into a project.
- Secret values are not added to the app's Kubernetes deployment. The app gets them from the SDK at run time.
- The SDK token is shown only once, when you create it.

### Audit log

| Action | Entry |
|---|---|
| Create | `secrets.create` |
| Update | `secrets.update` |
| Reveal | `secrets.reveal`, with key and environment |
| Delete | `secrets.delete` |
| Export | `secrets.export`, with the number of values |
| Bulk import | `secrets.import`, with the number of values |
| Rollback | `secrets.rollback` |

## For developers / API

The portal uses the merged variables API:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:projectId/environment?environmentId=` | Merged list. Secrets are always masked. `global` or empty = global rows only. |
| `PUT` | `/api/projects/:projectId/environment/:key` | Write a plain setting or a secret (moves it between stores) |
| `DELETE` | `/api/projects/:projectId/environment/:key?environmentId=&type=plain\|secret` | Delete |

The secrets API (kept for SDK and CLI use):

| Method | Path | Needs |
|---|---|---|
| `GET` | `/api/projects/:projectId/secrets` | `secrets.list`. Values masked. |
| `POST` | `/api/projects/:projectId/secrets` | `secrets.create`. Creates, or updates and bumps the version. |
| `POST` | `/api/projects/:projectId/secrets/reveal` | `secrets.reveal`, fresh code. Body `{ key, environmentId }`. |
| `DELETE` | `/api/projects/:projectId/secrets/:secretId` | `secrets.delete` |
| `GET` | `/api/projects/:projectId/secrets/export/:environmentId` | `secrets.export`, fresh code. Returns `{ environmentId, secrets: "KEY=value\n..." }`. |
| `POST` | `/api/projects/:projectId/secrets/bulk` | `secrets.import` |
| `GET` | `/api/projects/:projectId/secrets/:secretId/versions` | `secrets.list` |
| `POST` | `/api/projects/:projectId/secrets/:secretId/rollback/:version` | `secrets.rollback` |

Create a secret:

```http
POST /api/projects/:projectId/secrets
Authorization: Bearer <token>
Content-Type: application/json

{ "key": "DATABASE_URL", "value": "postgresql://user:pass@host:5432/db", "environmentId": "<environment id>" }
```

Answer: `201 { "id": "...", "key": "DATABASE_URL", "environmentId": "...", "version": 1 }`. Omit `environmentId` for a global secret.

Bulk import:

```http
POST /api/projects/:projectId/secrets/bulk
Content-Type: application/json

{
  "environmentId": "<environment id>",
  "secrets": [
    { "key": "DATABASE_URL", "value": "postgresql://..." },
    { "key": "API_KEY", "value": "sk-prod-xxx" }
  ]
}
```

Answer: `{ "imported": 2, "results": [{ "key": "DATABASE_URL", "status": "updated", "version": 4 }, ...] }`.

The SDK reads `GET /api/sdk/config?projectId=<name or id>&environmentId=<name or id>` with a server SDK token. Environment names are resolved to IDs on this endpoint. The answer is a flat object of keys and values, plus a `telemetry` block.

Create an SDK token (DevOps or tech lead):

```http
POST /api/projects/:projectId/tokens
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "production-token" }
```

Answer: `201` with `token` (`sdk_live_<32 hex characters>`) and `kind` (`server` by default, or `browser`).
