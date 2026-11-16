# Add a database to your app

Give your app a PostgreSQL, MongoDB or Redis database without installing anything. You manage a project's databases in the portal: open **Projects**, pick the project, then go to **Data**.

Cairn runs the databases on your server. Each project environment gets its own database and its own user, so one project cannot read another project's data.

## The quickest way: ask the SDK

Add `databases` when your app starts the Cairn SDK. Cairn creates whatever is missing and connects for you:

```js
import platform from '@mpratyush54/sdk-node';

await platform.init({
  projectName: 'shop',
  platformUrl: process.env.PLATFORM_URL,
  sdkToken: process.env.PLATFORM_SDK_TOKEN, // a server token
  environmentName: 'development',
  databases: ['postgres', 'mongo', 'redis'],
});

const { rows } = await platform.db.postgres.query('SELECT 1 AS ok');
await platform.db.redis.set('hello', 'world', 60); // expires after 60 seconds
```

Python works the same way with `databases=["postgres", "mongo", "redis"]`. See the [Python quickstart](../getting-started/python-sdk-quickstart.md).

You need a **server** SDK token. Create one in the project's **Settings**, under **SDK tokens**. See [Your first project](../getting-started/first-project.md#get-an-sdk-token-optional).

## Without the SDK: create a PostgreSQL database in the portal

You need the DevOps role.

1. Open the project and go to **Data**.
2. Under **Provision database**, choose the environment: Production, Staging or Preview.
3. Select **Provision database** and confirm.
4. Copy the credentials that appear. The password is shown only once.

The credentials are also saved as secrets of that environment, so your app can read them without you pasting anything.

## Where the credentials are

Cairn saves the credentials as secrets of the project environment. Your app reads them like any other setting:

| Database | Secrets |
|---|---|
| PostgreSQL | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| MongoDB | `MONGO_URI`, `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_DB` |
| Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_KEY_PREFIX` |

Redis is shared between projects. Each project can only use keys that start with its `REDIS_KEY_PREFIX`.

To see these values, open the project and go to **Configuration**. See [Secrets](secrets-management.md) for how secrets reach your app.

## Check on your databases

The project's **Data** section shows:

- **Database insights:** the slowest PostgreSQL queries, slow MongoDB operations and Redis key counts. This needs the `full` install profile. See [Database monitoring](../operations/database-monitoring.md).
- **Database connections:** each saved connection, with a **Test connection** button.
- **Database backups** (DevOps role): back up and restore the project's PostgreSQL database. See [Back up one project database](../operations/backups.md#back-up-one-project-database).

## Keep the data safe

- **Back up the whole server** with encrypted, off-site backups. See [Backups and restore](../operations/backups.md).
- **Run on several servers** for automatic failover. See [High availability](../operations/ha.md).

## How it works

- The databases run in the cluster's `databases` namespace. Project databases and users are named `plat_<project>_<environment>` and `plat_<project>_<environment>_user`.
- The portal's **Provision database** button creates PostgreSQL only. MongoDB and Redis are created when the SDK asks for them.
- Each project gets its own Redis user. Its access rules allow only keys and channels that start with the project's prefix, and block admin and dangerous commands.
- On a high availability install (`ha` profile), the Redis secrets also include `REDIS_SENTINELS`, `REDIS_SENTINEL_MASTER`, `REDIS_SENTINEL_USERNAME` and `REDIS_SENTINEL_PASSWORD`, so clients can find the current Redis primary.

## For developers / API

- Provision from the API: `POST /api/projects/<projectId>/databases/provision` with `{ "environment": "production" }`. DevOps role required. See the [Databases API](../api-reference/platform-api/databases.md).
- SDK database clients: Node.js [PostgreSQL](../api-reference/sdk-node/db-postgres.md), [MongoDB](../api-reference/sdk-node/db-mongo.md), [Redis](../api-reference/sdk-node/db-redis.md); Python [PostgreSQL](../api-reference/sdk-python/db-postgres.md), [MongoDB](../api-reference/sdk-python/db-mongo.md), [Redis](../api-reference/sdk-python/db-redis.md).
- File storage instead of a database: [File storage providers](../operations/storage-providers.md).
