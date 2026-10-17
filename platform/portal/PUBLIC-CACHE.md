# Public portal caching

`nginx.public.conf` is the origin configuration for `platform.pratyushes.dev`.
It sends `no-store` for HTML and legacy homepage redirects, gives content-named Angular bundles a one-year
immutable lifetime, and gives public media a one-hour browser / one-week
Cloudflare lifetime. Byte ranges, `Content-Length`, and origin ETags remain
available for MP4 seeking. Failed asset requests do not inherit cache headers.

`npm run build:public` computes a SHA-256 version for every player asset.
The player uses those versions in its query strings, so new videos, posters,
and captions get new cache keys without a purge. Preserve the query string in
Cloudflare's cache key. Desktop and portrait media have separate URLs; the
origin does not vary a single video URL by user agent.

## HTML and the canonical homepage

The public homepage renders directly at `/`. `/landing` and `/landing/` are
legacy URLs that redirect to `/`, preserving query strings and browser fragments.
HTML responses carry both `Cache-Control: no-store` and
`Cloudflare-CDN-Cache-Control: no-store`. Bundles and media retain their separate
cache policies.

An existing Cloudflare Cache Rule or Page Rule can override origin headers.
In particular, an Edge TTL override can keep stale HTML, and a Browser TTL
override can replace the origin's cache-control value. Changing nginx does not
clear objects already stored in the Cloudflare zone.

For this host, add a Cache Rule that bypasses HTML caching:

```text
http.host eq "platform.pratyushes.dev" and (
  http.request.uri.path in {"/" "/index.html" "/landing" "/landing/"}
  or (
    (http.request.uri.path eq "/docs" or starts_with(http.request.uri.path, "/docs/"))
    and not ends_with(http.request.uri.path, ".md")
  )
)
```

- Cache eligibility: **Bypass cache**.
- Browser TTL: **Respect existing headers**.
- Place this rule after broader matching cache rules. The last matching setting
  wins. Check any older Page Rules as well.

After Argo has deployed the new image, purge these exact URLs using Cloudflare's
Custom Purge:

```text
https://platform.pratyushes.dev/
https://platform.pratyushes.dev/index.html
https://platform.pratyushes.dev/landing
https://platform.pratyushes.dev/landing/
```

Reload previously open browser tabs afterward. To distinguish a stale edge
object from an old origin image, compare a normal request with a unique query
string and inspect the returned HTML, `Last-Modified`, `CF-Cache-Status`, and
`Age`. A query-string request is diagnostic; it does not purge the original URL.

Cloudflare documents [header precedence and Edge TTL overrides](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/)
and [Cache Rule ordering](https://developers.cloudflare.com/cache/how-to/cache-rules/order/).

## Cloudflare zone setup

The DNS record must be proxied through Cloudflare. MP4, JPEG, JS, and CSS are
cacheable file extensions by default. To include captions and explicitly enable
the whole public media directory, create this Cache Rule:

```text
http.host eq "platform.pratyushes.dev"
and starts_with(http.request.uri.path, "/media/")
```

- Cache eligibility: **Eligible for cache**.
- Edge TTL: respect origin cache-control headers.
- Browser TTL: respect existing headers.
- Preserve the full query string in the cache key.
- Enable **Respect Strong ETags** for video range requests.

Apply the rule only to the marketing host's media directory. No dashboard or
API response needs to become cacheable. Existing cache rules can override origin
headers, so inspect their order if a response stays `BYPASS` or `DYNAMIC`.

Origin configuration is checked by the repository's nginx tests. A live
Cloudflare cache hit can be verified only after deploying the public portal:
request a versioned MP4 URL twice from the same client and inspect
`CF-Cache-Status`, `Age`, `Content-Length`, `Accept-Ranges`, and a `206` response
to `Range: bytes=0-1023`. No Cloudflare account configuration is changed by the
build or the nginx configuration.

References: [CDN-Cache-Control](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/),
[default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/),
[strong ETags](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/#respect-strong-etags).
