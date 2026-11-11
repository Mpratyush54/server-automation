# Connecting GitHub and GitLab

The platform connects to GitHub and GitLab without any server run by the project. Each install
creates its own GitHub App and its own GitLab OAuth application. Open **Settings → Login (GitHub / GitLab)**
as an admin. Creating, replacing or removing provider credentials asks for a fresh MFA code.

## Requirements

GitHub and GitLab must reach the platform's public HTTPS URL, because they call it for the OAuth
callback (`/api/auth/<provider>/callback`) and for webhooks (`/api/webhooks/<provider>`). A real
domain works, and so does an [sslip.io](https://sslip.io) name such as `<server-ip>.sslip.io`.
The settings page warns you when the public URL is not HTTPS or not publicly reachable.

## GitHub: one click (GitHub App Manifest flow)

1. Choose **My personal account** or **An organization** (give the organization login), then
   click **Create GitHub App on GitHub**.
2. GitHub shows the pre-filled App. Change the name if you want (names are unique on GitHub),
   then click **Create GitHub App**.
3. GitHub sends you back to Settings. The platform exchanges the one-time code
   (`POST /app-manifests/{code}/conversions`) and stores the App id, slug, client id/secret,
   webhook secret and private key, all encrypted with `SECRETS_ENCRYPTION_KEY`.
4. Click **Install on repositories** and pick the repositories the platform should deploy.

After that:

- **Sign in with GitHub** uses the App (user-to-server OAuth). No OAuth App to create by hand.
- Repository calls (branches, commits, releases, repository listing) use short-lived
  installation tokens. They are minted with an RS256 App JWT and cached in Redis, encrypted,
  until 5 minutes before they expire.
- Push and pull request events for every installed repository arrive on the App webhook,
  signed with the App's webhook secret. Linking a repository (**Register webhook**) creates no
  per-repository hook and needs no personal token. If the App is not installed on the
  repository, the API answers `409` with the install link.
- `installation` and `installation_repositories` events keep the list of installations and
  their repositories up to date. **Sync installations** re-reads them from GitHub if a delivery
  was missed.

Permissions the App asks for: repository contents (read), metadata (read), pull requests (read),
and account email addresses (read, so sign-in only trusts verified emails). Events: push and
pull_request. GitHub sends installation events to every App without a subscription.

**Reconnect** creates a new App and replaces the stored credentials. **Disconnect** removes the
stored credentials. Delete the App on GitHub yourself if you no longer need it.

## GitLab: paste one token

1. Enter the GitLab URL (`https://gitlab.com` or your self-managed URL) and a token with the
   `api` scope.
2. If the token belongs to an instance administrator (self-managed only), leave **Group path**
   empty: the platform creates an instance-wide OAuth application (`POST /api/v4/applications`).
   Otherwise, enter a group you own. If your GitLab cannot create group applications through the
   API, the page shows the redirect URI and scopes so you can create the application in the
   group's **Settings → Applications** and enter it under *Advanced: manual OAuth app entry*.
3. The application id and secret are stored encrypted. The platform also creates a random
   webhook secret for the project hooks it registers.

By default the token is used once and discarded. Tick **Keep this token** if the platform
should register GitLab project webhooks automatically. GitLab has no installation tokens, so
creating a project hook needs an `api`-scoped token. A kept token is stored encrypted. Prefer a
group access token over a personal token for this.

## Manual entry (advanced fallback)

The manual client id/secret fields and the `GITHUB_TOKEN` / `GITLAB_TOKEN` linking tokens still
work. They are used only when no connected app provides the value. The order is: connected
app, then manual entry, then environment variables.
