# Your first project

This page helps you create a project in the portal and get it ready to deploy.

A project is one app. It has its own Git repository, three environments (development, staging and production), its own databases and secrets, and its own monitoring.

## Create a project

1. Sign in to the portal and open **Projects**.
2. Select **New project**.
3. Fill in the form:

   | Field | Example | What it is |
   |---|---|---|
   | Name | `shop` | Lowercase letters, numbers and dashes. Used in addresses and namespaces. |
   | Stack | Node.js | Node.js, Angular, Python or Static site |
   | Git repository | `https://github.com/acme/shop` | The repository Cairn deploys from. You can add it later. |
   | Base domain | `example.com` or `203.0.113.7.sslip.io` | Each environment gets an address under this domain. You can add it later. |

4. Select **Create project**.

Cairn creates the project with three environments: **development**, **staging** and **production**. Each one runs in its own Kubernetes namespace and gets its own address. You can see them on the project's **Deployments** page, under **Environments**.

## Connect your repository

If you did not add a repository in the form, open the project, go to **Configuration**, and set **Repository URL** under **Git and domain**.

For a private repository, connect GitHub or GitLab first, so Cairn can read it. See [Connect GitHub or GitLab](../guides/git-providers.md).

## Get an SDK token (optional)

You only need this if your app uses a Cairn SDK for logs, metrics or databases.

1. Open the project and go to **Settings**.
2. Under **Generate SDK token**, enter a name and pick the kind:
   - **Server** for backend code (Node.js, Python). It can read the project's settings and secrets, so keep it on the server.
   - **Browser** for frontend code (React, Angular). It can only send logs, metrics and bug reports.
3. Select **Generate token** and copy it. It is shown only once.

Then follow a quickstart: [Node.js](node-sdk-quickstart.md), [Python](python-sdk-quickstart.md), [React](react-sdk-quickstart.md) or [Angular](angular-sdk-quickstart.md).

## Next

[Deploy your app](deploy-your-app.md).
