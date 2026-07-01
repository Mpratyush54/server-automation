# Files API

Upload, download, and manage files through the platform's storage layer.

**Provider Types:** `local`, `s3`, `minio`, `google-drive`

---

## `POST` /api/storage/upload-url

Generates a pre-signed upload URL and registers the file in the database. Returns the upload endpoint URL and the file ID.

**Auth:** None (public endpoint)

**Request Body:**
```json
{
  "projectId": "uuid",
  "fileName": "screenshot.png",
  "mimeType": "image/png",
  "provider": "local",
  "bucket": "default-bucket",
  "category": "screenshots",
  "uploadedById": "uuid"
}
```

**Response `201`:**
```json
{
  "url": "/api/storage/upload-raw/{fileId}",
  "fileId": "uuid"
}
```

---

## `PUT` /api/storage/upload-raw/:fileId

Uploads the raw file content to the local filesystem. The request body should be the raw binary data. Updates the file size on completion.

**Auth:** None (public endpoint — uses pre-signed fileId)

**Headers:**
```
Content-Type: application/octet-stream
```

**Response `200`:**
```json
{
  "success": true,
  "size": 1048576
}
```

---

## `POST` /api/storage/confirm

Confirms a file upload by updating its size and CDN URL.

**Auth:** None (public endpoint)

**Request Body:**
```json
{
  "fileId": "uuid",
  "size": 1048576,
  "cdnUrl": "/api/storage/file/{fileId}"
}
```

**Response `200`:**
```json
{
  "id": "uuid",
  "size": 1048576,
  "cdnUrl": "/api/storage/file/uuid"
}
```

---

## `POST` /api/storage/delete

Soft-deletes a file and removes the physical file from disk. Requires authentication.

**Auth:** Bearer token

**Request Body:**
```json
{
  "fileId": "uuid"
}
```

**Response `200`:**
```json
{ "success": true }
```

---

## `GET` /api/storage/file/:id

Downloads a file by its ID. Returns the file with the correct MIME type. No authentication required.

**Auth:** None

**Response `200`:** Binary file content

**Error `404`:**
```json
{ "error": "File not found" }
```

---

## `GET` /api/storage/project/:projectId

Lists all non-deleted files for a project.

**Auth:** Bearer token

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "projectId": "uuid",
    "provider": "local",
    "bucket": "default-bucket",
    "storageKey": "{projectId}/{fileId}/screenshot.png",
    "originalName": "screenshot.png",
    "mimeType": "image/png",
    "size": 1048576,
    "category": "screenshots",
    "cdnUrl": "/api/storage/file/uuid",
    "createdAt": "2026-07-01T12:00:00.000Z"
  }
]
```

---

## `GET` /api/storage/analytics/:projectId

Returns storage analytics for a project.

**Auth:** Bearer token

**Response `200`:**
```json
{
  "totalBytes": 52428800,
  "count": 12,
  "providerBreakdown": {
    "local": 12
  }
}
```

---

## Error Codes

| Status | Error                        | Description                          |
|--------|------------------------------|--------------------------------------|
| 404    | `File registration not found`| Pre-registered file ID does not exist|
| 404    | `File not found`             | File ID not found or was deleted     |
| 404    | `Physical file not found`    | Database record exists but file is missing from disk |

---

## Related

- [Projects API](projects.md)
- [Databases API](databases.md)
- [Storage Provider Settings](/docs/api-reference/configuration/environment-variables)
