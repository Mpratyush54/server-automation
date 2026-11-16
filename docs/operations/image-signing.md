# Check that Cairn images are genuine

Every Cairn release image is scanned for known vulnerabilities and signed, so you can prove it was built by the project's own release pipeline. `platformctl` checks the signature for you on every install and update. Nothing needs to be set in the portal.

## What happens by default

When you run `sudo platformctl provision` or `sudo platformctl update`, platformctl checks the signatures of the API and portal images before it installs them.

| Situation | Default | With `PLATFORM_VERIFY_IMAGES=strict` |
|---|---|---|
| The signature is valid | continue | continue |
| The image has no signature | warning, continue | **stop** |
| The signature could not be checked | warning, continue | **stop** |
| The signature is invalid | **stop** | **stop** |
| The `cosign` tool is not installed | warning, continue | warning, continue |

To require a signature on every install:

```bash
sudo PLATFORM_VERIFY_IMAGES=strict platformctl update
```

## Check an image yourself

Install [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) (the signing tool), then:

```bash
cosign verify \
  --certificate-identity-regexp 'https://github.com/Mpratyush54/server-automation/\.github/workflows/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mpratyush54/platform-api:<tag>
```

The same command works for `platform-portal`, `platform-stack` and the `platformctl` copy on GHCR.

To see the list of components inside an image (its SBOM, a software bill of materials):

```bash
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp 'https://github.com/Mpratyush54/server-automation/\.github/workflows/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mpratyush54/platform-api:<tag>
```

## Block unsigned images in the cluster (optional)

You can also make the cluster itself refuse unsigned Cairn images. This uses Kyverno, a policy engine for Kubernetes. It is not installed by default because it needs about 200 MB and suits larger installs.

1. Install it with the full profile:

   ```bash
   export PLATFORM_PROFILE=full
   export INSTALL_KYVERNO=true
   sudo -E platformctl provision --auto
   ```

   On a running server you can use `sudo -E platformctl install kyverno` instead.

2. It starts in **Audit** mode: unsigned pods are reported, not blocked. Review the Kyverno policy reports.
3. When the reports are clean, switch to blocking:

   ```bash
   export KYVERNO_POLICY_MODE=Enforce
   sudo -E platformctl install kyverno
   ```

## How it works

### Release pipeline

| Workflow | What it does |
|---|---|
| `docker-build.yml` | Build, then Trivy scan (fails on a CRITICAL finding that has a fix; exceptions in `.trivyignore`), SARIF upload, CycloneDX SBOM, then cosign sign and attest |
| `publish-stack.yml` | cosign sign `platform-stack:<version>-<arch>` |
| `release-platformctl.yml` | cosign sign the `platformctl` OCI artifact on GHCR |
| `scan-third-party-images.yml` | Weekly Trivy scan of the images in `platformctl/internal/images/images.txt` (results as a private artifact and job summary only) |

Signing is keyless: cosign uses the GitHub Actions OIDC identity of the workflow instead of a stored key. Pull requests build and scan the images but never push or sign them.

Exceptions live in [`.trivyignore`](https://github.com/Mpratyush54/SERVER-automation/blob/master/.trivyignore). Every CVE line must have an expiry date and a short reason in a comment.

### platformctl check

platformctl runs `cosign verify` with the identity above (`platformctl/internal/verify/verify.go`) on the API and portal images, with a 2-minute time limit. A missing `cosign` binary is always only a warning, so offline installs still work.

### Kyverno policy

The ClusterPolicy `verify-platform-images` requires keyless cosign signatures on `ghcr.io/mpratyush54/*` images for pods in the `platform` namespace. `KYVERNO_POLICY_MODE` picks `Audit` (default) or `Enforce`.

**Optional CVE policy.** `INSTALL_KYVERNO_CVE_POLICY=true` adds a ClusterPolicy that expects Trivy Operator `VulnerabilityReport` objects in the `platform` namespace with `spec.summary.critical: 0`. platformctl does not install Trivy Operator. To use this:

1. Install [Trivy Operator](https://aquasecurity.github.io/trivy-operator/) yourself (Helm chart), with resource limits that fit the node.
2. Set `INSTALL_KYVERNO_CVE_POLICY=true` and run `platformctl install kyverno` again.
3. Keep `.trivyignore` as the allowlist with expiry dates. Do not silence CRITICAL findings in Enforce mode without a dated reason.

### Sign and enforce your own app images

You can use the same approach for your own apps in their project namespaces, without changing Cairn's own policy.

1. Sign your images in your own CI (keyless cosign with your workflow identity).
2. Apply a **namespaced** Kyverno `Policy` (not a ClusterPolicy), for example:

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

3. Change `validationFailureAction` to `Enforce` once Audit looks clean.

## For developers: policy tests

```bash
kyverno test platformctl/internal/manifests/data/kyverno-tests
```

CI runs the same suite in `security.yml`.
