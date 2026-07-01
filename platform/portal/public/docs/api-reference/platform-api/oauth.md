# OAuth 2.0 / OIDC API

OpenID Connect and OAuth 2.0 endpoints for third-party authentication. The platform dynamically generates an RSA-2048 keypair on startup for signing tokens.

---

## `GET` /api/oauth/.well-known/openid-configuration

Returns the OpenID Connect discovery document. This is the first endpoint OIDC clients should call to discover all other endpoints.

**Auth:** None

**Response `200`:**
```json
{
  "issuer": "https://api.example.com/api/oauth",
  "authorization_endpoint": "https://api.example.com/api/oauth/authorize",
  "token_endpoint": "https://api.example.com/api/oauth/token",
  "userinfo_endpoint": "https://api.example.com/api/oauth/userinfo",
  "jwks_uri": "https://api.example.com/api/oauth/jwks",
  "response_types_supported": ["code", "token", "id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": ["openid", "profile", "email", "groups"]
}
```

---

## `GET` /api/oauth/jwks

Returns the JSON Web Key Set (JWKS) containing the platform's public RSA key. Used by clients to verify ID and access token signatures.

**Auth:** None

**Response `200`:**
```json
{
  "keys": [
    {
      "kid": "plat-key-1",
      "use": "sig",
      "alg": "RS256",
      "kty": "RSA",
      "n": "base64url-encoded-modulus",
      "e": "AQAB",
      "key_ops": ["verify"]
    }
  ]
}
```

**Error `500`:**
```json
{ "error": "OAuth public key is not initialized" }
```

---

## `GET` /api/oauth/authorize

The OAuth 2.0 authorization endpoint.

If no `token` query parameter is provided, the user is redirected to the portal's OAuth consent page at `/oauth/authorize` with the original parameters forwarded.

If a valid portal JWT `token` is provided, an authorization code is generated (valid for 5 minutes) and the user is redirected back to the `redirect_uri` with the code and state.

**Auth:** None (redirects to portal for authentication if not already authenticated)

**Query Parameters:**
| Param         | Type   | Required | Description                              |
|---------------|--------|----------|------------------------------------------|
| client_id     | string | yes      | Client identifier                        |
| redirect_uri  | string | yes      | Callback URL after authorization         |
| response_type | string | no       | Response type (default: `code`)          |
| scope         | string | no       | Space-separated scopes (default: `openid`)|
| state         | string | no       | CSRF protection state                    |
| token         | string | no       | Pre-authenticated portal JWT             |

**Response `302` (no token):** Redirect to `{PORTAL_URL}/oauth/authorize?client_id=...`

**Response `302` (with token):** Redirect to `{redirect_uri}?code={uuid}&state={state}`

**Error `401` (invalid token):**
```json
{ "error": "Invalid or expired portal token" }
```

---

## `POST` /api/oauth/token

Exchanges an authorization code for an access token and ID token. Supports extracting the `client_id` from an HTTP Basic Auth header as a fallback.

The authorization code is consumed immediately (single-use). Returns:
- **Access token:** Signed with RS256, valid for 1 hour, contains `id`, `email`, `name`, `role`
- **ID token:** Signed with RS256, contains standard OIDC claims including `sub`, `name`, `email`, `groups`, `roles`

**Auth:** None (uses the authorization code for validation)

**Request Body:**
```json
{
  "code": "uuid-from-authorize",
  "client_id": "your-client-id",
  "redirect_uri": "https://yourapp.com/callback",
  "grant_type": "authorization_code"
}
```

**Response `200`:**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

**Error `400`:**
```json
{ "error": "Invalid or expired authorization code" }
```

---

## `GET` /api/oauth/userinfo

Returns information about the authenticated user. Requires a Bearer access token obtained from the token endpoint. The token is verified using the platform's RSA public key.

**Auth:** Bearer token (access token from `/api/oauth/token`)

**Headers:**
```
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**Response `200`:**
```json
{
  "sub": "user-uuid",
  "name": "John Dev",
  "email": "john@dev.io",
  "email_verified": true,
  "groups": ["developer"],
  "roles": ["developer"]
}
```

**Error `401`:**
```json
{ "error": "Authorization header with Bearer token is required" }
```

---

## OAuth Flow Summary

```
Client App                    Platform API
    |                              |
    |--- GET /.well-known --------->|  Discover endpoints
    |<-- Discovery document --------|
    |                              |
    |--- GET /authorize ----------->|  User authenticates (or redirects to portal)
    |<-- Redirect with code --------|
    |                              |
    |--- POST /token -------------->|  Exchange code for tokens
    |<-- access_token + id_token ---|
    |                              |
    |--- GET /userinfo ------------>|  Fetch user profile
    |<-- User claims ---------------|
```

---

## Error Codes

| Status | Error                                       | Description                        |
|--------|---------------------------------------------|------------------------------------|
| 400    | `client_id and redirect_uri are required`   | Missing required authorize params  |
| 400    | `Invalid or expired authorization code`     | Code not found or expired (5 min)  |
| 401    | `Invalid or expired portal token`           | Bad JWT on /authorize              |
| 401    | `Authorization header with Bearer...`       | Missing auth on /userinfo          |
| 401    | `Invalid access token: ...`                 | Bad or expired access token        |
| 404    | `User not found`                            | User does not exist                |
| 500    | `OAuth public key is not initialized`       | RSA keypair not generated          |

---

## Related

- [Auth API](auth.md)
- [Auth Flow Architecture](/docs/architecture/auth-flow)
- [Permissions Configuration](/docs/api-reference/configuration/permissions)
