# Public portal caching

`nginx.public.conf` is the origin configuration for `cairnpaas.dev`.
It sends `no-store` for HTML and legacy homepage redirects, gives content-named Angular bundles a one-year
immutable lifetime, and gives the link-preview images in `/media/` a one-hour
browser / one-week Cloudflare lifetime. Failed asset requests do not inherit
cache headers.

The landing page's feature clips are not served from this origin. They live in
a Cloudflare R2 bucket behind `https://media.cairnpaas.dev/v1/` (see
`videos/recordings/README.md`), and the page asks for them with a content
version in the query string (`landing-clip-versions.ts`), so a new cut gets a
new cache key without a purge. The CSP allows that host in `media-src`.

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
http.host eq "cairnpaas.dev" and (
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
https://cairnpaas.dev/
https://cairnpaas.dev/index.html
https://cairnpaas.dev/landing
https://cairnpaas.dev/landing/
```

Reload previously open browser tabs afterward. To distinguish a stale edge
object from an old origin image, compare a normal request with a unique query
string and inspect the returned HTML, `Last-Modified`, `CF-Cache-Status`, and
`Age`. A query-string request is diagnostic; it does not purge the original URL.

Cloudflare documents [header precedence and Edge TTL overrides](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/)
and [Cache Rule ordering](https://developers.cloudflare.com/cache/how-to/cache-rules/order/).

## Cloudflare zone setup

The DNS record must be proxied through Cloudflare. JPEG, PNG, JS, and CSS are
cacheable file extensions by default. To explicitly enable the public media
directory, create this Cache Rule:

```text
http.host eq "cairnpaas.dev"
and starts_with(http.request.uri.path, "/media/")
```

- Cache eligibility: **Eligible for cache**.
- Edge TTL: respect origin cache-control headers.
- Browser TTL: respect existing headers.
- Preserve the full query string in the cache key.

Apply the rule only to the marketing host's media directory. No dashboard or
API response needs to become cacheable. Existing cache rules can override origin
headers, so inspect their order if a response stays `BYPASS` or `DYNAMIC`.

Origin configuration is checked by the repository's nginx tests. A live
Cloudflare cache hit can be verified only after deploying the public portal:
request `/media/cairn-social.png` twice from the same client and inspect
`CF-Cache-Status` and `Age`. No Cloudflare account configuration is changed by
the build or the nginx configuration.

References: [CDN-Cache-Control](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/),
[default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
