# Feature clips: recorded from a real Cairn install

The landing page shows one short clip per feature, 20 to 40 seconds each. Every clip is a screen recording of Cairn running on real servers, driven by a Playwright script. Nothing is animated or mocked. Long waits are either cut or sped up, and the video labels each one on screen ("2 min skipped", "4x speed").

| Clip | What it shows | Script |
|---|---|---|
| `install` | `sudo platformctl provision` on a fresh server, then the sign-in page | `clips/install.mjs` |
| `deploy-from-git` | New project from a repository, deploy to production, open the app | `clips/deploy-from-git.mjs` |
| `observability` | Project overview charts, log search, trace waterfall, logs of one trace | `clips/observability.mjs` |
| `backups` | `backup target test`, an encrypted archive, a restore test, the result in Settings | `clips/backups.mjs` |
| `high-availability` | Infrastructure page beside a curl loop while one of three servers is powered off | `clips/high-availability.mjs` |
| `mcp` | A scoped agent token, an MCP client listing pods, a held scale command approved by a person | `clips/mcp.mjs` |

The pipeline has three stages:

1. `record.mjs` drives the portal (and terminal panes) at 1280x800 CSS pixels and 2x device scale, with `recordVideo`. It writes the raw video and named marks to `out/<clip>/`.
2. `post/process.mjs` cuts and labels the video, joins side-by-side panes, and encodes it. It writes H.264 MP4, VP9 WebM, a poster JPEG and WebVTT captions to `out/publish/`.
3. `publish.mjs` uploads the files to Cloudflare R2, checks them on `https://media.cairnpaas.dev/v1/`, and writes `landing-clip-versions.ts`. Once that file is committed, the landing page shows the clip instead of "Recording coming soon".

Run all of this on a disposable VM, never on a laptop. The VM needs the browser, ffmpeg and the downloads.

## How the scripts behave

- **Real selectors.** Locators come from the portal templates: roles with their visible labels, `data-testid` attributes, and the element ids in `platform/portal/src/app/pages/**`. When a template changes, the script fails loudly instead of recording the wrong screen.
- **Real states, not sleeps.** Every step waits for the API response it triggers (`/api/deploy`, `/query/loki`, `/api/settings/backups` and so on) and for the rendered result, such as a `Deployed` badge, a drawn chart or a `NotReady` status. `beat()` is only a short pause so viewers can read what changed. It is never used to wait for the app.
- **Followable input.** `lib/overlay.js` draws a subtle amber cursor and a click ripple. The cursor glides to each element, and typing runs at a human pace (`TYPING_MS`, default 70 ms per character, with jitter).
- **No secrets on screen.** The browser signs in through the API and the session goes straight into `localStorage`, so no password is typed on camera. Agent tokens are blurred and revoked at the end of the run. The age identity is piped over SSH and never printed. Casts are masked before they are replayed (see below).
- **Marks drive the edit.** Captions in `captions/<clip>.json` start and end at named marks (`"from": "deployed", "to": "live+1"`), so they stay in sync whatever the real timings were. A test checks that every caption uses a mark its script really sets.

### The install clip: why asciinema

A full install takes about five minutes, mostly waiting, and it prints the admin password. The clip is captured as text, with real timings, and rendered afterwards:

1. On the fresh server: `asciinema rec --cols 110 --rows 32 --command 'sudo -E platformctl provision --auto --profile full' install.cast`. This records every byte of output with its real timestamp.
2. `clips/install.mjs` masks secrets in the cast (labelled passwords, `plat_` tokens, AWS keys, age keys, plus the exact values in `REDACT_VALUES`) and shortens every pause longer than `INSTALL_MAX_IDLE` seconds (default 2). It then replays the cast into xterm.js in the recorded browser, in the Signal palette, and labels each shortened pause in the video. The edit plays the install itself at `INSTALL_SPEED` (default 3x) with a speed label; shortened pauses that land within two seconds of each other share one label with their total.

Other options were considered. Filming a real terminal cannot mask the password after the fact. `agg` renders a GIF, whose quality and size do not suit text. A `script(1)` typescript needs its own timing replay layer, which asciinema already provides. Because the replay renders in the same browser pipeline, the install clip has the same resolution, font and cursor as the others.

## Settings

Everything comes from the environment. Put it in `recording.env` (git-ignored) and pass `--env-file=recording.env`. Never commit it.

| Variable | Clips | Meaning |
|---|---|---|
| `CAIRN_URL` | all | Portal address, for example `https://203-0-113-10.sslip.io` |
| `CAIRN_EMAIL`, `CAIRN_PASSWORD` | all but install | An Admin or DevOps account made for the recording |
| `CAIRN_TOTP_SECRET` | if the account has two-factor sign-in; `mcp` always | Base32 authenticator secret, used for sign-in and step-up codes |
| `CAIRN_TOKEN` | optional | A JWT to reuse instead of signing in (saves a login: the API allows 20 per 15 minutes per address) |
| `INSTALL_CAST`, `REDACT_VALUES`, `INSTALL_MAX_IDLE`, `INSTALL_SPEED` | install | Cast file; newline-separated values to mask; longest pause kept; speed-up from the banner to "provisioned successfully" (default 3, labelled; 1 for real time) |
| `APP_REPO_URL`, `APP_BRANCH`, `APP_NAME`, `APP_EXPECT_TEXT`, `APP_PATH` | deploy-from-git | Repository with a `k8s/` folder; branch; unique project name; text the running app shows; folder with the deploy files when it is not `k8s/` |
| `OBS_PROJECT_ID`, `OBS_LOG_TEXT` | observability | Instrumented project; text in recent log lines that carry a trace ID |
| `BACKUP_SSH`, `BACKUP_IDENTITY_FILE`, `BACKUP_SKIP_ARCHIVE` | backups | `user@host` (key in ssh-agent); age `identity.txt`; `1` to skip taking an archive |
| `APP_URL`, `HA_NODE`, `HA_POWEROFF_CMD`, `HA_POWERON_CMD` | high-availability | The app's public address; the server to stop as shown on the Servers tab; shell commands to stop it and start it again |
| `MCP_PROJECT_ID`, `MCP_NAMESPACE`, `MCP_DEPLOYMENT`, `MCP_REPLICAS`, `MCP_CLIENT_CMD` | mcp | Project for the AI agents view; the demo app's namespace and Deployment; replicas to scale to (keep the current count); optional real assistant command line |
| `RECORD_THEME`, `TYPING_MS`, `HEADED`, `RECORDINGS_OUT`, `FONT_FILE` | optional | `dark` (default) or `light`; typing pace; `1` shows the browser; output folder; font for on-screen labels |

## Run it on a fresh disposable install

Use throwaway servers and accounts made only for the recording, so no real data, customer names or credentials can appear on screen. Terminate everything afterwards.

### 1. Servers

The same recipe as the end-to-end tests: AWS EC2 in any region, Ubuntu 24.04, with ports 80 and 443 open and SSH allowed only from your own address.

- **One server** (`t3.xlarge`, 100 GB gp3) is enough for install, deploy-from-git, observability, backups and mcp.
- **Three servers** (`t3.large` or larger, 80 GB or more each, a private network between them, and a self-referencing security-group rule while the test runs) for high-availability. Provision node 1 with `--profile ha`. Join the other two with `platformctl token create --role server ...` and `platformctl --auto join --role server ...`, then run `sudo platformctl install longhorn` (see `docs/operations/ha.md`). Wait until every server and volume is healthy before powering one off.
- **Somewhere off-site for backups:** an R2 or S3 bucket made for the test, or MinIO on a small separate VM.
- A domain: `<server-ip-with-dashes>.sslip.io` works without DNS.

Record the install clip on a fresh server with asciinema, before anything else:

```bash
sudo apt-get install -y asciinema
export DOMAIN=203-0-113-10.sslip.io ADMIN_EMAIL=demo@example.com AUTO_UPDATE=false
# Backup bucket keys go in the environment, never on the command line (docs/operations/backups.md).
asciinema rec --cols 110 --rows 32 --command 'sudo -E platformctl provision --auto --profile full' install.cast
```

Copy `install.cast` to the recording VM. It contains the admin password, so delete it from both machines after processing.

### 2. Seed data

- **deploy-from-git:** a small public repository with `k8s/deployment.yaml` and `k8s/service.yaml` (Service on port 80, image already built, two replicas). The app's page should show recognisable text for `APP_EXPECT_TEXT`.
- **observability:** an app built on the Cairn Node SDK (see `examples/sdk-apps/` and `docs/api-reference/sdk-node/PlatformClient.md`), deployed with a server token, and real traffic for 15 minutes before recording, for example `while true; do curl -s https://<app>/api/orders >/dev/null; sleep 0.3; done` from another machine. Traces need `--profile full`.
- **backups:** `sudo platformctl backup target set ...` with the test bucket, an age key pair made on the recording VM (`age-keygen -o identity.txt`), then `sudo platformctl backup init --recipient <age1...>`. See `docs/operations/backups.md`.
- **high-availability:** deploy the app with at least two replicas on different servers, and make sure its address reaches whichever server is up (VIP or load balancer). `HA_POWEROFF_CMD` can be `aws ec2 stop-instances --force --instance-ids <id>` (a real power loss) or `ssh <node> sudo poweroff` (a clean shutdown; say so in the captions if you use it). An EC2 instance gets a new public IP when it starts again, so map the sslip.io name in `/etc/hosts` or use an Elastic IP.
- **mcp:** the demo app's namespace and Deployment name (shown on the project's Environments card), with remote MCP enabled (a public domain).

### 3. Record, process, check

On the recording VM (Ubuntu, Node 22):

```bash
sudo apt-get install -y ffmpeg fonts-ibm-plex awscli
cd videos/recordings
npm install
npx playwright install --with-deps chromium
node --env-file=recording.env record.mjs install deploy-from-git observability backups mcp
node --env-file=recording.env record.mjs high-availability      # against the 3-server install
node post/process.mjs all                  # add --title-card for a 1 s title, --av1 for AV1 WebM
```

Watch every file in `out/publish/` before publishing. For high-availability, compare the captions with `high-availability.evidence.json`, which holds every request the curl loop made. If requests failed while the server was down, change the captions to say so. Never trim the evidence away.

To record a real assistant for the mcp clip instead of the bundled client (`lib/mcp-client.mjs`, which calls the same remote MCP tools), set `MCP_CLIENT_CMD`, for example `claude -p "..." --mcp-config cairn.json`. It gets `CAIRN_URL` and `CAIRN_AGENT_TOKEN` in its environment. The bundled client waits for the line `approved` on standard input before it reruns the held command, and the script sends that line after the approval. A custom client must handle approval itself.

### 4. Publish to R2

Run this once per bucket, in the Cloudflare dashboard or with the API: create the bucket, connect the custom domain `media.cairnpaas.dev`, and set the CORS policy from `r2-cors.json`. The landing page loads captions cross-origin with `crossorigin="anonymous"`, so CORS is required. With the AWS CLI:

```bash
aws s3api put-bucket-cors --bucket <bucket> --cors-configuration "{\"CORSRules\": $(cat r2-cors.json)}" \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

Then:

```bash
export R2_ACCOUNT_ID=... R2_BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # an R2 API token scoped to the bucket
node publish.mjs upload            # out/publish/* to v1/<clip>.* with types and one-year cache headers
node publish.mjs check             # each URL on the media host: status, type, CORS
node publish.mjs versions          # writes platform/portal/src/app/pages/landing/landing-clip-versions.ts
```

Commit `landing-clip-versions.ts`. Each URL carries `?v=<content hash>`, so a new cut never collides with a cached old one. The site's CSP already allows `https://media.cairnpaas.dev` in `media-src`.

## Tests

`node --test videos/recordings/test/*.test.mjs` covers the parts that need no browser: TOTP codes, cut and speed-up maths, caption timing, cast masking and idle capping, the ffmpeg filter graph, the media host matching the landing page, and every caption using a mark its script sets. The browser scripts can only be checked against a live install.

## The older films

`../platform-explainer` and `../platform-short` are the earlier HyperFrames wireframe films. They are no longer on the site. Their sources are kept for reference and can be deleted.
