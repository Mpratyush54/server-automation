# What Cairn is

Cairn turns one Ubuntu server, or a small cluster, into your own place to deploy and run apps.

You install it with one command. You then get a web portal where you create projects, deploy them from Git, add databases, keep secrets, and watch logs, metrics and errors. Everything runs on your own machine.

## Start here

1. [Install Cairn](getting-started/installation.md) on a server.
2. [Create your first project](getting-started/first-project.md) in the portal.
3. [Deploy an app](getting-started/deploy-your-app.md) from your Git repository.

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

## What you get

- **Deploys from Git.** Pick a branch and commit, and Cairn deploys the Kubernetes files in your repository with Argo CD. Branches can get their own preview environment. Cairn can also build images from your source code, if you turn builds on.
- **Databases.** PostgreSQL, MongoDB and Redis run on the server. Each project gets its own credentials.
- **Secrets.** Encrypted settings for each environment, with history and rollback.
- **Monitoring.** Logs, metrics, traces, error tracking, uptime checks and alerts, in the portal.
- **Sign-in and roles.** Passwords, two-factor sign-in, GitHub or GitLab sign-in, and roles that limit who can do what.
- **Backups.** Encrypted backups to S3-compatible storage, and a restore you can test.
- **AI agents.** Paste your server's `/mcp` address into Claude, ChatGPT, Cursor or VS Code and sign in. Assistants get only the access you approve, and risky commands wait for a person.
- **SDKs.** Node.js, Python, React and Angular libraries connect your app to logs, metrics and databases.

## How it fits together

Cairn runs on k3s, a small Kubernetes distribution. The installer, `platformctl`, sets up k3s, the databases, Argo CD, the monitoring stack, and the Cairn API and portal. Each project environment gets its own Kubernetes namespace.

```text
              Browser / SDK
                    |
            Ingress (HTTPS)
                    |
   +----------------+----------------+
   |                |                |
Cairn API        Portal           Argo CD
   |
PostgreSQL · MongoDB · Redis · MinIO
```

For the full picture, see [How Cairn works](architecture/overview.md).

## Find your way around

| You want to | Go to |
|---|---|
| Install on a server | [Install](getting-started/installation.md) |
| Ship your app | [Deploy an app](getting-started/deploy-your-app.md) |
| Add a database | [Databases](guides/databases.md) |
| Protect your data | [Backups and restore](operations/backups.md) |
| See what is happening | [Monitoring and alerts](guides/monitoring.md) |
| Run on several servers | [High availability](operations/ha.md) |
| Fix a broken install | [Recover](operations/recover.md) and [Troubleshooting](troubleshooting/README.md) |
| Look up a command | [CLI](getting-started/platformctl.md) |
