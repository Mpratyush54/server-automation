# Image scanning, signing, and admission

Platform release images (`ghcr.io/mpratyush54/platform-api` and
`platform-portal`) are scanned with Trivy, signed keyless with cosign
(GitHub Actions OIDC), and can be verified both by `platformctl` and by
Kyverno admission policies.

## What CI does

| Workflow | Action |
|---|---|
| `docker-build.yml` | Build → Trivy (fail on CRITICAL with a fix; `.trivyignore`) → SARIF upload → CycloneDX SBOM → cosign sign + attest |
| `publish-stack.yml` | cosign sign `platform-stack:<version>-<arch>` |
| `release-platformctl.yml` | cosign sign the GHCR `platformctl` OCI artifact |
| `scan-third-party-images.yml` | Weekly Trivy of `platformctl/internal/images/images.txt` (private artifact + job summary only) |

Pull requests build and scan locally; they never push or sign.

Allowlist entries live in [`.trivyignore`](../../.trivyignore). Every CVE
line must include an **expiry date** and a short reason in a comment.

## Verify a release image by hand

```bash
cosign verify \
  --certificate-identity-regexp 'https://github.com/Mpratyush54/server-automation/\.github/workflows/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mpratyush54/platform-api:<tag>
```

The same identity is used for `platform-portal`, `platform-stack`, and the
`platformctl` GHCR mirror.

To inspect the CycloneDX SBOM attestation:

```bash
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp 'https://github.com/Mpratyush54/server-automation/\.github/workflows/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mpratyush54/platform-api:<tag>
```

## platformctl verification (all profiles)

Before installing or updating API/portal images, `platformctl` runs
`cosign verify` with the identity above.

| Situation | Default (`PLATFORM_VERIFY_IMAGES` unset/warn) | `PLATFORM_VERIFY_IMAGES=strict` |
|---|---|---|
| cosign not installed | warn, continue | warn, continue |
| no signature | warn, continue | **fail** |
| invalid signature | **fail** | **fail** |

## Enable Kyverno admission (full profile, opt-in)

Kyverno is **not** installed by default (it is ~200 MB and only makes sense
on fuller installs). Enable it explicitly:

```bash
export PLATFORM_PROFILE=full
export INSTALL_KYVERNO=true
# Optional: switch from Audit (default) to Enforce
export KYVERNO_POLICY_MODE=Enforce
sudo platformctl provision --auto
# or: sudo platformctl install kyverno
```

The ClusterPolicy `verify-platform-images` requires keyless cosign signatures
on `ghcr.io/mpratyush54/*` Pods in the `platform` namespace. Start in
**Audit**, review Kyverno policy reports, then set
`KYVERNO_POLICY_MODE=Enforce` and re-run `platformctl install kyverno`.

### Optional CVE policy (Trivy Operator)

`INSTALL_KYVERNO_CVE_POLICY=true` applies a ClusterPolicy that expects
Trivy Operator `VulnerabilityReport` objects in the `platform` namespace
with `spec.summary.critical: 0`.

platformctl does **not** install Trivy Operator. If you want that feed:

1. Install [Trivy Operator](https://aquasecurity.github.io/trivy-operator/)
   yourself (Helm chart) with resource limits appropriate for the node.
2. Set `INSTALL_KYVERNO_CVE_POLICY=true` and re-apply Kyverno policies.
3. Keep CI `.trivyignore` as the allowlist with expiries; do not silence
   CRITICAL findings in Enforce mode without a dated reason.

## Tenant opt-in: sign and enforce your own images

Tenants can reuse the same pattern in their project namespaces without
changing the platform ClusterPolicy.

1. Sign images in the tenant CI (keyless cosign + their workflow identity).
2. Apply a **namespaced** Kyverno `Policy` (not ClusterPolicy), for example:

```yaml
apiVersion: kyverno.io/v1
kind: Policy
metadata:
  name: verify-tenant-images
  namespace: my-app
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: verify-tenant-ghcr
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences:
            - "ghcr.io/example-org/my-app*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/example-org/my-app/.github/workflows/*"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          required: true
```

3. Move `validationFailureAction` to `Enforce` after Audit looks clean.

## Policy tests

```bash
kyverno test platformctl/internal/manifests/data/kyverno-tests
```

CI runs the same suite in `security.yml`.
