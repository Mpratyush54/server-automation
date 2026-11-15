# Your first project

This page helps you create a project in the portal and get it ready to deploy.

A project is one app. It has its own Git repository, three environments (development, staging and production), its own databases and secrets, and its own monitoring.

## Before you start

If your code is in a **private** repository, connect GitHub or GitLab first, so Cairn can read it: open **Settings**, **Git linking** and follow [Connect GitHub or GitLab](../guides/git-providers.md). A public repository works without this. You can also leave the repository out for now and add it later.

## Create a project

1. Sign in to the portal, open **Projects** and select **New project**.
2. Work through the steps. Only the name is required; select **Skip** on any step marked *Optional*.

   | Step | What to enter |
   |---|---|
   | **App** | A **Name**, for example `shop`: lowercase letters, numbers and dashes. It becomes part of each environment's address. Pick the **Stack** (Node.js, Angular, Python or Static site). |
   | **Code** (optional) | The **Repository address**, for example `https://github.com/acme/shop`, and the **Branch to deploy**. Leave the branch empty to use the repository's default branch. |
   | **Environments** | A **Base domain**, for example `example.com`, with a wildcard DNS record `*.example.com` pointing at your server. No domain? Use `<server-ip>.sslip.io`. Leave it empty to use the server's own domain. |
   | **Data** (optional) | Tick **PostgreSQL** for each environment that needs a database. |
   | **Settings** (optional) | Environment variables and secrets your app reads, and privacy defaults for browser monitoring. |
   | **Team** (optional) | People who should work on the app, and their role. You are added as the owner. |

3. On **Review**, select **Create project**.

Cairn creates the project with its three environments. Each one runs in its own isolated space on the server and gets its own address, such as `shop-development-<code>.example.com`, where `<code>` is a short code that keeps addresses unique. You can see the addresses on the project's **Deployments** page, under **Environments**.

If you ticked a database, its password is shown once, right after the project is created. Copy it then.

## Add or change the repository later

Open the project, go to **Configuration** and fill in **Repository** under **Repository and address**. Select **Save changes**.

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
