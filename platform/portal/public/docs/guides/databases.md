# Databases

This page helps you give your app a PostgreSQL, MongoDB or Redis database.

Platform runs PostgreSQL, MongoDB and Redis on your server. Each project environment gets its own database and its own user, so one project cannot read another's data. You do not install or run the databases yourself.

## The quickest way: ask the SDK

Add `databases` when your app starts the Platform SDK. Platform creates what is missing and connects for you:

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
await platform.db.redis.set('hello', 'world', 60);
```

Python works the same way with `databases=["postgres", "mongo", "redis"]`. See the [Python quickstart](../getting-started/python-sdk-quickstart.md).

You need a **server** SDK token. See [Your first project](../getting-started/first-project.md#get-an-sdk-token-optional).

## Without the SDK: create a PostgreSQL database in the portal

1. Open the project and go to **Data**.
2. Under **Provision database**, choose the environment.
3. Select **Provision database**.
4. Copy the credentials that appear. The password is shown only once.

You need the DevOps role to do this.

## Where the credentials are

Platform saves the credentials as secrets of the project environment, so your app can read them like any other setting:

| Database | Secrets |
|---|---|
| PostgreSQL | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| MongoDB | `MONGO_URI`, `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_DB` |
| Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_KEY_PREFIX` |

On a high availability install, Redis also has `REDIS_SENTINELS` and related settings. See [Secrets](secrets-management.md) for how secrets reach your app.

## Check on your databases

The project's **Data** page shows database insights, connection pools and a **Test connection** button. For slow queries and other health signals, see [Database monitoring](../operations/database-monitoring.md).

## Keep the data safe

- **Back up** the server's databases with encrypted, off-site backups. See [Backups and restore](../operations/backups.md).
- **Run on several servers** for automatic failover. See [High availability](../operations/ha.md).

## Reference

- SDK database clients: Node.js [PostgreSQL](../api-reference/sdk-node/db-postgres.md), [MongoDB](../api-reference/sdk-node/db-mongo.md), [Redis](../api-reference/sdk-node/db-redis.md); Python [PostgreSQL](../api-reference/sdk-python/db-postgres.md), [MongoDB](../api-reference/sdk-python/db-mongo.md), [Redis](../api-reference/sdk-python/db-redis.md).
- [Databases API](../api-reference/platform-api/databases.md)
- File storage instead of a database: [File storage providers](../operations/storage-providers.md)
