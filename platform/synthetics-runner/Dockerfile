# Browser synthetic check runner (#42). Full profile + SYNTHETICS_BROWSER=true only.
# Budget: image ~1.5 GiB (Chromium + system libraries from the Playwright base
# image); each run is limited to 1 CPU / 1 GiB memory (CronJob + LimitRange) and
# at most 2 runs execute at once (ResourceQuota in the synthetics namespace).
# playwright-core must match the browser build of the base image tag.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# certutil: trusts the platform's internal CA in the per-run browser profile
# (only when the check targets the project's own environment hosts; runner.mjs).
# Security updates for the base image's Ubuntu packages are applied at build time.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends libnss3-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /runner
COPY package.json ./
# npm is only needed to install playwright-core; the runner runs with `node`, so npm
# and its bundled packages are removed instead of shipped (and patched).
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force \
    && rm -rf /usr/lib/node_modules/npm /usr/lib/node_modules/corepack /usr/bin/npm /usr/bin/npx /usr/bin/corepack /root/.npm
COPY runner.mjs ./

# Non-root (Pod Security "restricted"); the CronJob also sets runAsUser.
USER 10001:10001
ENTRYPOINT ["node", "/runner/runner.mjs"]
