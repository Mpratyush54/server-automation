# StorageClient

Upload, sign download URLs, and delete files through the Platform storage API.

---

## Import

```typescript
import { StorageClient } from '@mpratyush54/sdk-node';

// Access via client instance:
// client.storage.upload(...)
```

---

## Constructor

```typescript
const storage = new StorageClient(httpInstance: AxiosInstance);
```

Normally you use the pre-configured `client.storage` instance from `PlatformClient`, which is already wired to the platform HTTP client and configured with your project name after `init()`.

---

## Methods

### `configure(projectName)`

```typescript
storage.configure(projectName: string): void
```

Sets the project context. Called automatically by `PlatformClient.init()`.

---

### `upload(file, options)` — Upload a file

```typescript
storage.upload(
  file: Buffer | string,
  options: {
    filename: string;
    contentType: string;
    category: string;
  }
): Promise<object | null>
```

**Parameters:**

| Param | Type | Description |
|---|---|---|
| `file` | `Buffer \| string` | File content as a `Buffer`, or a **file path** (string) to read from disk |
| `options.filename` | `string` | Desired file name (e.g. `report.pdf`) |
| `options.contentType` | `string` | MIME type (e.g. `application/pdf`) |
| `options.category` | `string` | Logical grouping (e.g. `documents`, `images`, `backups`) |

**Returns:** The upload confirmation object, or `null` on failure.

**Upload flow (3 steps):**

1. `POST /api/storage/upload-url` — obtains a pre-signed upload URL and file ID.
2. `PUT <signed-url>` — uploads the raw bytes.
3. `POST /api/storage/confirm` — confirms the upload with size and CDN URL.

---

### `signedUrl(fileId, options?)` — Get download URL

```typescript
storage.signedUrl(
  fileId: string,
  options?: { expiresIn?: number }
): Promise<string>
```

Returns a full URL pointing to the file at `{baseURL}/api/storage/file/{fileId}`.

---

### `delete(fileId)` — Delete a file

```typescript
storage.delete(fileId: string): Promise<boolean>
```

Returns `true` if deletion succeeded, `false` otherwise.

---

## Full Example

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';
import * as fs from 'fs';

const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-app',
    platformUrl: 'https://platform.example.com',
  });

  // 1. Upload a Buffer
  const result1 = await client.storage.upload(Buffer.from('Hello, world!'), {
    filename: 'hello.txt',
    contentType: 'text/plain',
    category: 'documents',
  });
  console.log('Uploaded:', result1);

  // 2. Upload a file from disk
  const result2 = await client.storage.upload('/tmp/screenshot.png', {
    filename: 'screenshot.png',
    contentType: 'image/png',
    category: 'screenshots',
  });
  const fileId = result2?.fileId || result2?.id;
  console.log('File ID:', fileId);

  // 3. Get a download URL
  if (fileId) {
    const url = await client.storage.signedUrl(fileId);
    console.log('Download URL:', url);
  }

  // 4. Delete the file
  if (fileId) {
    const deleted = await client.storage.delete(fileId);
    console.log('Deleted:', deleted);
  }
}

main();
```

---

## Error Handling

- `upload()` returns `null` on any failure (network error, API rejection) and logs a warning.
- `delete()` returns `false` on failure.
- The **only** exception thrown is when methods are called before `configure()` — in that case `upload()` and `signedUrl()` throw `'SDK Storage not initialized'`.
