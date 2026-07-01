# Your First Project

Get started by creating a project, setting up environments, and triggering your first deployment.

## 1. Log In

Open [http://localhost:4200](http://localhost:4200) and log in with the admin account:

| Email | Password |
|---|---|
| admin@dev.io | (none required — click Sign In) |

## 2. Create a Project

1. Click **Projects** in the sidebar.
2. Click **Create Project**.
3. Fill in the form:

| Field | Value |
|---|---|
| Project Name | `My App` |
| Git Repository | `https://github.com/your-org/my-app.git` |

4. Click **Create**.

A **SDK Token** is generated automatically for the project. Copy it — you will need it when configuring an SDK.

> If you lose the token, go to **Project Settings → SDK Token** to regenerate it.

## 3. Create Environments

1. Open your project from the Projects list.
2. Go to the **Environments** tab.
3. Create the following environments:

| Name | Branch | Auto-Deploy | Preview |
|---|---|---|---|
| `dev` | `main` | Yes | No |
| `staging` | `main` | Yes | No |
| `production` | `main` | Yes | No |

4. Click **Save**.

Each environment maps to a deployment target. The API creates a dedicated Kubernetes namespace per environment.

## 4. Trigger a Deployment

1. Go to the **Deployments** tab.
2. Click **New Deployment**.
3. Select the `dev` environment.
4. Enter a Git commit SHA (or leave blank to use the latest).
5. Click **Deploy**.

The deployment pipeline:

```text
Commit → API receives request → builds container → pushes to registry → applies k8s manifest → health check → ready
```

6. Watch the status update in real time: `Queued → Building → Deploying → Healthy`

## 5. View Your Deployed App

Once the deployment is healthy, the portal shows:

- **URL** — the ingress address for the environment
- **Logs** — real-time container logs via Loki
- **Metrics** — CPU, memory, request latency (p50/p95/p99)
- **Secrets** — environment-specific encrypted configuration

## Next Steps

- [Set up the Node.js SDK](node-sdk-quickstart.md) to instrument your app
- [Learn about the deployment pipeline](deploy-your-app.md)
- [Configure preview environments](../guides/preview-environments.md)
