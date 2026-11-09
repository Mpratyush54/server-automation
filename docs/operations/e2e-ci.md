# End-to-end VM suite in CI

`.github/workflows/e2e-vm.yml` provisions a fresh Ubuntu 24.04 server on AWS
EC2 with the candidate `platformctl` and platform images, runs the functional
and security regression suite against it, uploads logs and timings, and
destroys the server. It also gates releases: a stable version only becomes the
**Latest** GitHub release after this suite passes.

## What runs when

| Trigger | Profiles | platformctl | Platform images | Stack |
|---|---|---|---|---|
| Nightly (02:23 UTC, `master`) | `minimal` and `full` | built from the commit | `master` | `edge` |
| Tag push `vX.Y.Z` / `vX.Y.Z-rc.N` | `minimal` and `full` | the release binary (checksum verified) | `X.Y.Z[-rc.N]` | `stable` |
| Manual (`workflow_dispatch`) | `minimal` (default), `full` or `both` | built from the selected ref, or a release given as input | the release's tag, `master` for `master`, otherwise `master` with a notice | `edge` (`stable` for releases) |

Images are only published for `master` and release tags
(`docker-build.yml`). A run on any other branch uses the latest `master`
images; the job summary says so. The dispatch inputs `image_tag` and `stack`
override both choices.

Before the VM starts, a `prepare` job builds or downloads `platformctl` and
waits (up to 40 minutes) until the `platform-api` and `platform-portal` images
for the chosen tag exist, so a tag push does not race the image build.

### One run, step by step

1. **Launch** (`scripts/e2e/aws-vm.sh launch`): a per-run security group (SSH
   from the runner's public IPv4 only, 80 and 443 from anywhere), then a
   `t3.xlarge` instance from Canonical's Ubuntu 24.04 SSM parameter with a 100 GB
   gp3 disk, spot first and on-demand if spot capacity is unavailable. The SSH
   client key and the VM's **host** key are generated in the job; cloud-init
   installs both, so the first connection is verified rather than trusted.
   Every resource is tagged `purpose=platform-e2e-ci`, `run-id`, `profile`,
   `created-at`, `expires-at`. The VM schedules its own power-off after 150
   minutes and powering off terminates it.
2. **Provision** (`scripts/e2e/provision.sh`): copies `platformctl` and runs
   `platformctl provision --auto --profile <profile>` with
   `DOMAIN=<ip>.sslip.io`, `PLATFORM_IMAGE_TAG`, `PLATFORM_STACK` and a
   generated admin password. Settings travel over SSH stdin into a root-only
   file, never on a command line. The console output (which contains the admin
   password) stays in the runner's private work directory; only a redacted copy
   is uploaded.
3. **Checks** (`scripts/e2e/run-checks.sh`), one `PASS`/`FAIL`/`SKIP` line
   each. HTTP checks use the public domain like a user would; cluster checks
   use `kubectl` through an SSH tunnel; host checks run over SSH.

   | Check | What it proves |
   |---|---|
   | `tls-validity` | every public host presents a valid, matching certificate (Let's Encrypt, or the platform's internal CA when it fell back to it; the run notes which) |
   | `api-health` | API liveness/readiness, portal, API on the portal host |
   | `admin-login` | admin login, authenticated request, wrong password rejected |
   | `security-unauth` | admin and SDK endpoints answer 401/403 without credentials, with a malformed token and with a forged unsigned JWT |
   | `security-headers` | API and portal security headers, HTTP to HTTPS redirect, no stack traces in errors |
   | `sdk-register-logs-metrics` | Node SDK register, logs, metrics, heartbeat (`scripts/e2e-sdk-live.mjs`) |
   | `db-credentials-issue`, `db-postgres`, `db-mongo`, `db-redis` | the SDK issues per-project credentials for each engine; each authenticates, can read/write its own database (or key prefix) and nothing else |
   | `sdk-apps-deploy` | `examples/sdk-apps` (Node API, React, Angular) built, deployed, reachable over HTTPS, every engine healthy from the project namespace, telemetry arrives |
   | `sso-oidc-discovery` | OIDC discovery and JWKS of the platform provider |
   | `sso-grafana`, `sso-argocd`, `sso-portainer` (full) | a complete SSO login as the admin: redirect with the right client and redirect URI, consent, code redeemed by the tool, tool session |
   | `argocd-sync` (full) | an Argo CD Application for `examples/sdk-demo/k8s` at the tested commit becomes Synced and Healthy |
   | `tenant-isolation` | `platform/api/scripts/test-namespace-isolation.mjs`: default-deny isolation matrix, Pod Security, quotas |
   | `backup-restore` | `platformctl backup init` (file target), `backup --all`, `backup list`, `backup restore-test`. MinIO is excluded because a fresh server has no `mc` client |

   Probe details live in the test code (`scripts/e2e/checks/`); the job log
   only shows pass/fail.
4. **Collect** (always): `/var/log/platformctl` (per-step logs,
   `timings.txt`, `timings.json`), cloud-init output, k3s journal, pods, events,
   workloads, `describe` of unhealthy pods and every container's logs, plus the
   output of each check. Everything is passed through `scripts/e2e/redact.py`
   (values from the server's `/etc/platform/.env`, the admin password, issued
   database credentials, and generic token shapes) before upload.
   `/etc/platform` itself is never collected.
5. **Teardown** (always, `aws-vm.sh teardown`): terminates the instance and
   deletes the security group, found both from the run's state and by tags.
6. **Summary**: the job summary shows the phases, every check with its
   duration, and provision step timings (slowest first). The artifact
   `e2e-<profile>-<run>-<attempt>` (kept 14 days) has the logs and
   `results.jsonl`, `phases.jsonl`, `timings.json`, `summary.md`.

Any failed check fails the job; the logs are uploaded either way.

## Release gate

GoReleaser publishes **every** tag as a GitHub pre-release
(`platformctl/.goreleaser.yaml`: `prerelease: "true"`, `make_latest: "false"`).
For a stable tag `vX.Y.Z`, the `promote` job of `e2e-vm.yml` runs only when
both profiles passed with the release binary and the release's own images. It
waits for `release-platformctl.yml` to finish successfully, then:

- `gh release edit vX.Y.Z --prerelease=false --latest`
- moves the GHCR copy `ghcr.io/mpratyush54/platformctl:latest` (the
  `install.sh` fallback) to that version. `release-platformctl.yml` no longer
  moves `latest` itself.

`-rc` tags are tested the same way but stay pre-releases forever.

What this means for users:

- `install.sh` and `releases/latest/download/...` resolve GitHub's Latest
  release, which ignores pre-releases. **Stable installs keep getting the
  previous release until the new one passes e2e.** `PLATFORMCTL_VERSION=vX.Y.Z`
  still installs a specific (pre-)release explicitly.
- The portal's "latest version" check already prefers non-pre-releases.
- Container images (`docker-build.yml`) are still pushed on the tag; the gate
  covers the GitHub release and the `platformctl` binary channel.
- If the AWS variables are not configured, tags stay pre-releases. A maintainer
  can promote by hand after testing (`gh release edit vX.Y.Z --prerelease=false --latest`);
  treat that as an exception and say why in the release notes.
- To re-run the gate for an existing tag (for example after a flaky run), use
  **Run workflow** on the tag with profile `both`.

## One-time setup (AWS role and repository variables)

The workflows authenticate with GitHub OIDC; no AWS keys are stored in GitHub.

1. With IAM admin rights in the AWS account that should host the VMs, review
   and run:

   ```sh
   scripts/e2e/aws-oidc-setup.sh --region <region> --dry-run   # print the policies
   scripts/e2e/aws-oidc-setup.sh --region <region>
   ```

   It creates the GitHub OIDC provider (if missing), the role
   `platform-e2e-ci` (2-hour sessions) and the EC2 Spot service-linked role.
   The role's trust policy accepts only tokens for
   `repo:Mpratyush54/server-automation:environment:e2e-aws` (change with
   `--repo` / `--environment`; the `sub` claim is case-sensitive). Its inline
   policy allows, in that one region only: Describe calls; reading the public
   Ubuntu AMI parameter; creating tagged security groups and adding rules to or
   deleting groups tagged `purpose=platform-e2e-ci`; `RunInstances` only for
   tagged instances of the allowed types (`--instance-types`, default
   `t3.xlarge,t3a.xlarge`) with tagged volumes up to 200 GB and a tagged
   security group; creating tags only during those create calls; terminating
   only tagged instances.
2. In the repository settings create the environment **`e2e-aws`** and limit
   its deployment branches and tags to `master` and `v*` (add a branch
   temporarily to validate it with `workflow_dispatch`).
3. Set repository variables (Settings, Secrets and variables, Actions,
   Variables):

   | Variable | Required | Value |
   |---|---|---|
   | `E2E_AWS_ROLE_ARN` | yes | the role ARN printed by the setup script |
   | `E2E_AWS_REGION` | yes | the region used above |
   | `E2E_INSTANCE_TYPE` | no | default `t3.xlarge` (must be allowed by the role) |
   | `E2E_SUBNET_ID` | no | a public subnet; default: the default VPC |
   | `E2E_MAX_AGE_MINUTES` | no | janitor threshold, default `120` |

Without `E2E_AWS_ROLE_ARN` and `E2E_AWS_REGION` the workflows skip with a
notice, so forks stay green.

## Cost control

- Spot instances with on-demand fallback; one VM per profile, released at the
  end of the job.
- The VM job has a 90-minute hard limit, with smaller limits per step so that
  collection and teardown always run inside it.
- The VM powers itself off (and terminates) 150 minutes after launch.
- `.github/workflows/e2e-janitor.yml` runs hourly and terminates instances and
  deletes security groups tagged `purpose=platform-e2e-ci` older than 120
  minutes (or past `expires-at`). With the hourly schedule nothing survives
  3 hours. Run it by hand with `dry_run` to see what it would remove.

A nightly run (two `t3.xlarge` VMs for about 20-30 minutes each, spot) costs
a few cents per profile plus EBS for the same time.

## Running it by hand

- **From GitHub:** Actions, *e2e VM*, *Run workflow*; pick the ref, profile,
  and optionally a release (`platformctl_version`), image tag or stack.
- **From a workstation** (your own AWS credentials, a role with the same
  permissions; region of your choice):

  ```sh
  export AWS_REGION=<region> E2E_WORK=$(mktemp -d) E2E_ARTIFACTS=$(mktemp -d)
  export E2E_RUN_ID=manual-$(date +%s) E2E_PROFILE=minimal E2E_IMAGE_TAG=master
  (cd platformctl && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$E2E_WORK/platformctl" .)
  (cd sdk-node && npm ci && npm run build) && (cd platform/api && npm ci && npm run build)
  scripts/e2e/aws-vm.sh keys && scripts/e2e/aws-vm.sh launch
  PLATFORMCTL_BIN=$E2E_WORK/platformctl scripts/e2e/provision.sh
  scripts/e2e/run-checks.sh            # E2E_ONLY="api-health admin-login" runs a subset
  scripts/e2e/collect.sh; scripts/e2e/aws-vm.sh teardown
  node scripts/e2e/summary.mjs
  ```

  Always run `teardown` (the VM self-destructs after 150 minutes anyway). The
  checks need `node` 22, `kubectl`, `docker`, `jq`, `python3` and `ssh`.

## Reading the results

- **Job summary:** verdict, phases (launch, provision), one row per check,
  provision step timings. A `skip` is expected for Argo CD, Grafana and
  Portainer checks on the `minimal` profile.
- **Provision failed:** the job log shows the last 40 (redacted) lines of the
  provision output. In the artifact, `logs/raw/provision-console.log` is the
  full output and `logs/raw/vm/platformctl/<step>.log` the failing step's log;
  `logs/raw/vm/cluster/events.txt` and `unhealthy-pods-describe.txt` usually
  show why a component did not become ready.
- **A check failed:** `logs/raw/checks/<check>.log` has its full output;
  pod logs are under `logs/raw/vm/cluster/logs/`.
- **Timings:** `timings.json` (written by `platformctl` next to `timings.txt`)
  has every step's start, duration and status; compare runs to spot
  regressions in install time.

## Files

| Path | Purpose |
|---|---|
| `.github/workflows/e2e-vm.yml` | the suite and the release promotion |
| `.github/workflows/e2e-janitor.yml` | hourly clean-up of expired e2e resources |
| `.github/workflows/e2e-scripts.yml` | lint and unit tests of the tooling (no cloud) |
| `scripts/e2e/plan.sh` | what to test (profiles, binary, images, stack, promotion) |
| `scripts/e2e/aws-vm.sh` | keys, launch, teardown, janitor |
| `scripts/e2e/aws-oidc-setup.sh` | one-time IAM setup |
| `scripts/e2e/provision.sh`, `run-checks.sh`, `collect.sh`, `summary.mjs` | the run |
| `scripts/e2e/checks/`, `deploy-sdk-apps.sh`, `argocd-sync.sh`, `remote/` | the checks |
| `scripts/tests/e2e-*.test.mjs` | unit tests |
