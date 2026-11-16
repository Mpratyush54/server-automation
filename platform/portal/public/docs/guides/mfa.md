# Two-factor sign-in

Two-factor sign-in asks for a 6-digit code from an authenticator app after your password, so a stolen password is not enough. You turn it on from your **Profile** page (click your avatar). Admins set which roles must use it in **Settings > Security**.

Any authenticator app works, for example 1Password, Bitwarden, Google Authenticator or Aegis. Passkeys and SMS codes are not supported.

## Turn it on

1. Open your **Profile** page. Find **Two-factor authentication** and choose **Set up authenticator**.
2. Scan the QR code with your authenticator app. If you cannot scan it, type the key shown under it.
3. Enter the 6-digit code from the app and choose **Verify and enable**.
4. Save your 10 recovery codes with **Download** or **Copy**, then choose **I saved my codes**.

Recovery codes are shown only once. Each one works once, in place of an app code, if you lose your phone.

Admins and DevOps users must set this up. If they have not, they are sent to a setup screen right after signing in, and can do nothing else until they finish.

## When you are asked for a code again

Some sensitive actions ask for a fresh code even when you are signed in. The code is valid for 15 minutes, then you are asked again. These actions are:

- revealing or exporting secrets, and turning a secret into a plain variable
- rotating Cairn's own passwords
- creating agent tokens for AI tools
- connecting or removing a GitHub or GitLab integration
- resetting another user's two-factor sign-in
- changing which roles must use two-factor sign-in

If you have not set up two-factor sign-in, the dialog sends you to your Profile page first.

## Lost your phone

- **Use a recovery code.** Sign in with a recovery code instead of the app code. Then, on your Profile page, enter a code and choose **New recovery codes**, or turn two-factor off and set it up again.
- **Ask an admin.** An admin opens **Users** and chooses **Reset MFA** on your account. You set it up again at your next sign-in if your role requires it.
- **No admin can sign in.** On the server, as root:

  ```bash
  sudo platformctl mfa disable --user admin@example.com
  ```

  Then sign in with your password and set up two-factor sign-in again. This works even when the portal is down.

## Choose which roles must use it

1. Open **Settings** in the sidebar and choose the **Security** tab.
2. Tick the roles that must use two-factor sign-in. The default is admin and DevOps.
3. Save. You are asked for a fresh code.

Only admins can change this. DevOps users can see it.

You can turn two-factor sign-in off on your Profile page with **Turn off**, unless your role requires it.

## How it works

- Codes are standard time-based one-time passwords (TOTP, RFC 6238) with 30-second steps.
- Codes from the step before and after are accepted, to allow for clock drift.
- Each code is accepted only once. Reusing a code, or a code from an earlier step, fails.
- Failed code attempts are limited per account: 10 per 15 minutes by default. The counters are shared by every API replica.
- After the password, users with two-factor turned on get a challenge that expires after 5 minutes. GitHub and GitLab sign-in go through the same challenge.
- A session limited to setup lasts 1 hour and can only reach the setup endpoints.
- Agent tokens for AI tools (`plat_agent_*`) do not use two-factor sign-in. Their scopes, and human approval of destructive commands, control them instead.
- Authenticator secrets are stored encrypted with AES-256-GCM using `SECRETS_ENCRYPTION_KEY` (or `JWT_SECRET` when that is not set). Recovery codes are stored as bcrypt hashes.
- The built-in sign-in provider copies `amr` and `auth_time` into the tokens it gives Grafana, Argo CD and other tools, so they can require two-factor sign-in.
- `platformctl mfa disable` runs `psql` in the PostgreSQL pod (namespace `databases`). It deletes the user's factor and recovery codes and writes an `auth.mfa.break_glass_disable` audit entry. `--database` picks the database name; the default is `POSTGRES_DB` from the `platform-env` secret, else `platform`.

### Settings

| Setting | Default | What it does |
|---|---|---|
| `mfa.requiredRoles` (Settings > Security) | `[admin, devops]` | Roles that must use two-factor sign-in |
| `MFA_REQUIRED_ROLES` | unset | Used when the setting was never saved. Comma list, or `none`. |
| `MFA_STEP_UP_MAX_AGE_SEC` | `900` | How long a fresh code counts for sensitive actions |
| `MFA_RATE_LIMIT_MAX` | `10` | Failed code attempts per account per 15 minutes |
| `MFA_ISSUER` | `Platform (<DOMAIN>)` | Name shown in authenticator apps |

### Session claims

| Claim | Meaning |
|---|---|
| `amr` | `pwd` (password) or `fed` (GitHub/GitLab), plus `otp` and `mfa` after a second factor |
| `auth_time` | When the user last authenticated (seconds). Refreshed by a fresh code. |
| `mfa_enroll` | Present on sessions limited to setup |

### Audit log

Every event is recorded: `auth.mfa.enroll_started`, `auth.mfa.enroll_failed`, `auth.mfa.enabled`, `auth.mfa.enrollment_forced`, `auth.mfa.challenge_succeeded`, `auth.mfa.challenge_failed`, `auth.mfa.recovery_code_used`, `auth.mfa.step_up`, `auth.mfa.step_up_failed`, `auth.mfa.recovery_codes_regenerated`, `auth.mfa.recovery_codes_failed`, `auth.mfa.disabled`, `auth.mfa.disable_failed`, `auth.mfa.admin_reset`, `auth.mfa.break_glass_disable` and `settings.mfa.updated`.

## For developers / API

When an action needs a fresh code, the API answers:

```json
HTTP 401
{ "error": "step_up_required", "maxAgeSec": 900 }
```

The portal then asks for a code, calls `POST /api/auth/mfa/step-up` and retries. The new session has `auth_time` set to now and `mfa` in `amr`.

Sign-in for a user with two-factor turned on: `POST /api/auth/login` answers `mfa_required` with a challenge token. Finish with `POST /api/auth/mfa/challenge`. The GitHub/GitLab one-time code exchange answers the same way.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/mfa/status` | On or off, setup pending, recovery codes left, whether your role requires it |
| `POST` | `/api/auth/mfa/enroll` | Returns `otpauthUri`, `qrDataUrl` (PNG data URL) and `secret`. Pending until verified. |
| `POST` | `/api/auth/mfa/verify` | `{ code }` → `{ recoveryCodes, token }` (full session) |
| `POST` | `/api/auth/mfa/challenge` | `{ challengeToken, code }` → `{ token, user }`. `code` may be a recovery code. |
| `POST` | `/api/auth/mfa/step-up` | `{ code }` → `{ token }` |
| `POST` | `/api/auth/mfa/recovery-codes` | `{ code }` → new `recoveryCodes`. Old ones stop working. |
| `POST` | `/api/auth/mfa/disable` | `{ code }`. Refused (`mfa_required_by_policy`) when your role requires it. |
| `POST` | `/api/users/:id/mfa/reset` | Admin, fresh code. Removes the user's factor. |
| `GET` | `/api/settings/mfa` | Policy (DevOps or admin) |
| `PUT` | `/api/settings/mfa` | `{ requiredRoles }` (admin, fresh code) |

Endpoints that need a fresh code:

- `POST /api/projects/:projectId/secrets/reveal`
- `GET /api/projects/:projectId/secrets/export/:environmentId`
- converting a secret variable to plain in the environment-variables API
- `POST /api/settings/rotate-secrets`
- `POST /api/agent-tokens`
- `POST /api/settings/integrations/github/manifest`, `.../github/manifest/complete`, `POST /api/settings/integrations/gitlab/connect`, `DELETE /api/settings/integrations/:provider/app`
- `POST /api/users/:id/mfa/reset`
- `PUT /api/settings/mfa`

The OpenAPI document (`GET /api/openapi.json`) describes request and response bodies.
