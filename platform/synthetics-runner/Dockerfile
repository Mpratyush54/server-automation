# Browser synthetic check runner (#42). Full profile + SYNTHETICS_BROWSER=true only.
# Budget: image ~1.5 GiB (Chromium + system libraries from the Playwright base
# image); each run is limited to 1 CPU / 1 GiB memory (CronJob + LimitRange) and
# at most 2 runs execute at once (ResourceQuota in the synthetics namespace).
# playwright-core must match the browser build of the base image tag.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# certutil: trusts the platform's internal CA in the per-run browser profile
# (only when the check targets the project's own environment hosts; runner.mjs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libnss3-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY runner.mjs ./

# Non-root (Pod Security "restricted"); the CronJob also sets runAsUser.
USER 10001:10001
ENTRYPOINT ["node", "/runner/runner.mjs"]
