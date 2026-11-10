# Multi-factor authentication (TOTP)

The portal supports time-based one-time passwords (TOTP, RFC 6238) from any authenticator app
(1Password, Bitwarden, Google Authenticator, Aegis, ...), with single-use recovery codes.

- Users in the roles listed by the `mfa.requiredRoles` policy (default **admin** and **devops**)
  must enrol before they can use the portal.
- Revealing or exporting secrets, rotating platform secrets, creating agent tokens, resetting
  another user's MFA and changing the MFA policy need a **fresh second factor** (step-up).
- Agent tokens (`plat_agent_*`) are non-interactive and are not subject to MFA: they stay
  governed by their scopes and by human approval of destructive commands.

WebAuthn / passkeys and SMS are not supported.

## Enrolling (portal)

1. Open **Profile → Two-factor authentication** and choose **Set up authenticator**.
2. Scan the QR code (or type the secret shown under it) in your authenticator app.
3. Enter the 6-digit code from the app. MFA is now on.
4. Save the 10 **recovery codes** (Download or Copy). They are shown once. Each code works once
   and replaces a TOTP code when you lose your device.

Admins and devops users without MFA are sent to a forced-enrolment screen right after signing in;
until they finish, their session can only reach the enrolment endpoints.

## Signing in

| First factor | MFA enabled | Result |
|---|---|---|
| Password or GitHub/GitLab | yes | `mfa_required` + a 5-minute challenge token, then the code |
| Password or GitHub/GitLab | no, role requires it | session restricted to enrolment |
| Password or GitHub/GitLab | no, role does not require it | normal session |

GitHub/GitLab logins go through the same steps: the one-time `?code=` exchange answers
`mfa_required` instead of a session when the user has MFA enabled.

A TOTP code is accepted once: reusing a code (or a code from an earlier 30-second step) fails.
Codes from the previous and next step are accepted to tolerate clock drift. Failed attempts are
rate-limited per account (10 per 15 minutes by default) with counters shared by every API replica.

## Step-up

When an action needs a fresh second factor the API answers:

```json
HTTP 401
{ "error": "step_up_required", "maxAgeSec": 900 }
```

The portal then asks for a code, calls `POST /api/auth/mfa/step-up` and retries. The new session
token has `auth_time` set to now and `amr` containing `mfa`. Users without MFA must enrol first
(the step-up dialog links to the profile page).

Protected endpoints: `POST /api/projects/:projectId/secrets/reveal`,
`GET /api/projects/:projectId/secrets/export/:environmentId`, `POST /api/settings/rotate-secrets`,
`POST /api/agent-tokens`, `POST /api/users/:id/mfa/reset`, `PUT /api/settings/mfa`.

## Session token claims

| Claim | Meaning |
|---|---|
| `amr` | RFC 8176 methods: `pwd` (password) or `fed` (GitHub/GitLab), plus `otp` and `mfa` after a second factor |
| `auth_time` | When the user last authenticated (seconds); refreshed by step-up |
| `mfa_enroll` | Present on enrolment-only sessions |

The built-in OIDC provider copies `amr` and the portal `auth_time` into ID tokens and access
tokens, so Grafana, Argo CD and other relying parties can require `mfa`.

Sessions issued before this release have no `amr`: they keep working until they expire (24 h), but
step-up protected actions ask for a code, and the enrolment requirement applies at the next login.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/mfa/status` | enabled, pending, recovery codes left, whether your role requires MFA |
| `POST` | `/api/auth/mfa/enroll` | returns `otpauthUri`, `qrDataUrl` (PNG data URL) and `secret`; pending until verified |
| `POST` | `/api/auth/mfa/verify` | `{ code }` → `{ recoveryCodes, token }` (full session) |
| `POST` | `/api/auth/mfa/challenge` | `{ challengeToken, code }` → `{ token, user }`; `code` may be a recovery code |
| `POST` | `/api/auth/mfa/step-up` | `{ code }` → `{ token }` |
| `POST` | `/api/auth/mfa/recovery-codes` | `{ code }` → new `recoveryCodes` (old ones stop working) |
| `POST` | `/api/auth/mfa/disable` | `{ code }`; refused (`mfa_required_by_policy`) when your role requires MFA |
| `POST` | `/api/users/:id/mfa/reset` | admin; removes the user's factor (they re-enrol at next login) |
| `GET`/`PUT` | `/api/settings/mfa` | policy `requiredRoles` (PUT: admin with step-up) |

The OpenAPI document (`GET /api/openapi.json`) describes request and response bodies.

## Policy and configuration

| Setting | Default | Description |
|---|---|---|
| `mfa.requiredRoles` (Settings → Security (MFA), `PUT /api/settings/mfa`) | `[admin, devops]` | Roles forced to enrol |
| `MFA_REQUIRED_ROLES` env | unset | Used when the setting was never saved; comma list or `none` |
| `MFA_STEP_UP_MAX_AGE_SEC` env | `900` | Max age of the second factor for step-up actions |
| `MFA_RATE_LIMIT_MAX` env | `10` | Failed code attempts per account per 15 minutes |
| `MFA_ISSUER` env | `Platform (<DOMAIN>)` | Issuer label shown in authenticator apps |

TOTP secrets are stored encrypted (AES-256-GCM with `SECRETS_ENCRYPTION_KEY`, falling back to
`JWT_SECRET` when unset, like project secrets). Recovery codes are stored as bcrypt hashes.

## Lost device

- **Recovery code:** sign in with a recovery code instead of the TOTP code, then regenerate codes
  or re-enrol from the profile page.
- **Admin reset:** an admin opens **Users**, chooses **Reset MFA** on the user (audit-logged as
  `auth.mfa.admin_reset`). The user enrols again at next login if their role requires it.
- **Break-glass (no admin can sign in):** on the server, as root:

  ```bash
  sudo platformctl mfa disable --user admin@example.com
  ```

  This works without the API: it runs `psql` inside the PostgreSQL pod (namespace `databases`),
  deletes the user's factor and recovery codes, and writes an `auth.mfa.break_glass_disable` audit
  log entry. Sign in with the password afterwards and enrol again.

## Audit log

Every MFA event is recorded: `auth.mfa.enroll_started`, `auth.mfa.enroll_failed`,
`auth.mfa.enabled`, `auth.mfa.enrollment_forced`, `auth.mfa.challenge_succeeded`,
`auth.mfa.challenge_failed`, `auth.mfa.recovery_code_used`, `auth.mfa.step_up`,
`auth.mfa.step_up_failed`, `auth.mfa.recovery_codes_regenerated`, `auth.mfa.recovery_codes_failed`,
`auth.mfa.disabled`, `auth.mfa.disable_failed`, `auth.mfa.admin_reset`,
`auth.mfa.break_glass_disable` and `settings.mfa.updated`.
