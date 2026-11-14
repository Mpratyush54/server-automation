# Store files in S3, R2 or another bucket

Choose where Cairn keeps files your apps upload through the SDK, and where project database backups go. Go to **Settings** in the sidebar and open the **Storage** tab. You need the DevOps role.

Every install starts with **Bundled MinIO**, storage that runs on your own server. Add an outside bucket when you want files to survive losing the server, or to keep them in a cloud you already use.

## Add a provider

1. Create a bucket at your provider, and an access key that can put, get and delete objects in that bucket only.
2. In **Settings > Storage**, under **Add a storage provider**, pick the **Provider**: AWS S3, Cloudflare R2, Google Cloud Storage (HMAC), Backblaze B2, Generic S3 or MinIO.
3. Fill in the fields the form shows, then select **Save provider**.
4. Select **Test connection** on the new provider. It stays "unknown" until tested.
5. To use it for new uploads and backups, select **Make default**.

What each provider needs:

| Provider | Fields |
|---|---|
| AWS S3 | Region, access key ID, secret access key, bucket |
| Cloudflare R2 | Account ID (32 hexadecimal characters), access key ID, secret access key, bucket. The endpoint and region are filled in for you. |
| Google Cloud Storage | An HMAC key (from the bucket's interoperability settings), not a service account JSON key. Bucket. |
| Backblaze B2 | Region (for example `us-west-004`), access key ID, secret access key, bucket |
| Generic S3 | Endpoint URL, region (optional), access key ID, secret access key, bucket |
| MinIO | Endpoint URL, access key ID, secret access key, bucket |

Example: to move uploads to Cloudflare R2, create an R2 bucket and an API token scoped to it, add it as **Cloudflare R2**, test it, then select **Make default**. New uploads go to R2. Files already uploaded stay readable where they are.

## Switch the default safely

- **Make default** affects new SDK uploads and new project database backups only.
- Each file remembers the provider it was stored with. Reading or deleting it still uses that provider.
- You cannot delete Bundled MinIO, the current default, or a provider that files or backups still use.

## Move old local files into a bucket

Older installs may have uploads on local disk. To copy them:

1. Make sure every API replica can read the old uploads folder at the same `UPLOADS_DIR` path.
2. On an S3-compatible or MinIO provider, select **Copy local files here**.
3. Watch the progress in the portal.

Nothing moves automatically. The originals are kept. If the copy stops with an error, fix the cause and select **Copy local files here** again: files already copied are skipped. This copies SDK uploads only, not local backup files.

## How it works

- **Bundled storage.** `platformctl provision` creates two MinIO buckets, `platform-uploads` and `platform-backups`, plus an API user whose policy allows only those buckets. It runs `mc` inside the MinIO pod and reuses the credentials in the `platform-storage` Kubernetes Secret on later runs. The API gets these scoped keys as `MINIO_API_ACCESS_KEY` and `MINIO_API_SECRET_KEY` in `platform-env`. The MinIO root credentials stay with the admin backup and recovery tools.
- **Registration.** On start, the API encrypts any older provider credentials with `SECRETS_ENCRYPTION_KEY` and registers **Bundled MinIO** with a fixed ID, under a database lock so several replicas agree. Only one provider can be the default. A default you chose earlier is kept. Keep the same encryption key when you restore a database. In development, registration is skipped when the scoped MinIO keys are missing.
- **Secrets.** Provider secrets never appear in list or save responses.
- **Addressing.** AWS uses virtual-hosted bucket addresses. All other providers use path-style addresses.
- **Test connection** writes a uniquely named object under `__platform_probe/`, reads it back, checks it and deletes it. Each step times out after ten seconds, with no retry. Errors say which step failed and whether it was sign-in, bucket or region, permission or network, without passing on the provider's message or credentials. Cleanup is tried even if the write timed out. If the delete fails, the result says so; you may need to remove the probe object yourself.
- **Health checks.** Only the elected API leader checks providers: one second after start, then every five minutes. The portal shows the result, the check time and the last error.
- **Copy local files** runs as a `storage.migrate-local` operation in the operations worker. It copies live local upload rows in batches of 100, records each finished row as a checkpoint, and resumes after a restart. If a local file is missing, it stops with an error that names the problem.
- **Older files.** Files saved before providers existed have no provider ID and keep using the store set by the environment. Keep `MINIO_ENDPOINT` and `UPLOADS_S3_*` when upgrading.
- **Google Drive** providers created on older installs stay readable. Google Drive is for backups only and cannot be the default for uploads. While a Google Drive provider is the default, SDK uploads use the environment-configured store until you choose a compatible default.
- **Upgrading** to this feature needs the normal pre-rollout migration job (`1790000036000-StorageProviders`) and `platformctl provision` to create the scoped credentials. No extra services or images are added.
- Not yet verified on a fresh server: a full run of provision, an R2 provider as default, and an interrupted local copy resuming.

## For developers / API

All routes need the DevOps role.

| Action | Request |
|---|---|
| List providers | `GET /api/settings/storage` |
| Add a provider | `POST /api/settings/storage` with `preset` (`aws`, `r2`, `gcs`, `b2`, `s3`, `minio`), `name`, `bucketName`, `endpointUrl`, `accountId` (R2), `credentials` (`accessKeyId`, `secretAccessKey`, `region`) and `isDefault` |
| Test | `POST /api/settings/storage/<id>/test` |
| Make default | `PATCH /api/settings/storage/<id>/set-default` |
| Copy local files | `POST /api/settings/storage/<id>/migrate-local` (returns an operation; follow it at `/api/operations`) |
| Delete | `DELETE /api/settings/storage/<id>` |
