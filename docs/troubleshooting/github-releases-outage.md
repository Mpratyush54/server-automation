# Installing while GitHub Releases is down

GitHub Releases serves the `platformctl` binary, the k3s binary and 7 of the 12
pinned Helm charts. During a Releases outage those downloads fail (HTTP 502/504),
often only for anonymous requests, while the rest of GitHub keeps working.
GitHub Container Registry (GHCR) is a separate service, so every install
artifact also has a copy there, and installs fall back to it automatically.

| Artifact | Normal source | Fallback (anonymous, digest-verified) |
|---|---|---|
| `platformctl` | GitHub Releases | `ghcr.io/mpratyush54/platformctl:<version>` (and `:latest` for stable releases) |
| k3s binary + install script | get.k3s.io → GitHub Releases | `ghcr.io/mpratyush54/k3s:<k3s version, + → ->` |
| Helm charts | each chart's repository | `oci://ghcr.io/mpratyush54/charts/<chart>:<version>` |
| Container images | GHCR / Docker Hub / quay.io | not affected by Releases outages |

## What you see

`install.sh` prints `GitHub Releases unavailable; trying the GHCR mirror`.
`platformctl provision` prints `⚠ <chart>: upstream chart download failed, used
the GHCR mirror` or `⚠ k3s download failed (...); installing ... from the GHCR
mirror`. Nothing else changes: the same versions are installed.

If the install script itself cannot be downloaded from Releases, fetch it from
the repository instead:

```sh
curl -fsSL https://raw.githubusercontent.com/Mpratyush54/server-automation/master/platformctl/install.sh | bash
sudo platformctl provision
```

Pin a version with `PLATFORMCTL_VERSION=v1.3.0` as usual; the fallback uses the
same version. The GHCR copy of `platformctl` carries Linux builds only.

## How the mirrors are kept current

- `.github/workflows/mirror-artifacts.yml` copies every chart in
  `platformctl/internal/versions` and the pinned k3s release to GHCR. It runs
  when those versions change on `master`, weekly, and on demand, skips what is
  already mirrored, makes the packages public and checks that anonymous pulls
  work. Its downloads are authenticated, which kept working during the
  November 2026 Releases outage.
- The release workflow pushes each `platformctl` release to GHCR. Pre-releases
  never move `:latest`.
- CI (`scripts/gen-images.sh`) and the offline bundle build
  (`scripts/build-bundle.sh`) fall back to the chart mirror too.

When you bump a chart or k3s version, merge to `master` and let the mirror
workflow finish before tagging a release.
