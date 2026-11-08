#!/bin/bash
set -euo pipefail
: "${PORTAL_URL:?Set PORTAL_URL, e.g. https://platform.example.com}"
: "${PLATFORM_URL:?Set PLATFORM_URL to the API origin}"
echo "=== images ==="
sudo k3s kubectl -n platform get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,POLICY:.spec.template.spec.containers[0].imagePullPolicy
echo "=== api symbols ==="
sudo k3s kubectl -n platform exec deploy/platform-api -- sh -c 'ls dist/lib/git-remote.js; grep -c "git/releases" dist/routes/projects.js; grep -c projectIdMongoFilter dist/routes/sdk.js || true'
echo "=== portal bundle strings ==="
curl -sk "${PORTAL_URL%/}/" -o /tmp/portal.html
JS=$(grep -oE 'main-[A-Za-z0-9]+\.js' /tmp/portal.html | head -1)
echo "bundle=$JS"
curl -sk "${PORTAL_URL%/}/$JS" -o /tmp/main.js
grep -oE 'Pull from GitHub|GitHub Releases|Update to|feature/CU-123-auth|Deploy Service' /tmp/main.js | sort -u || true
echo "=== auto-update ==="
sudo k3s kubectl -n platform get cronjob platform-auto-update -o jsonpath='suspend={.spec.suspend}{"\n"}' 2>/dev/null || echo no-cron
echo "=== health ==="
curl -sf "${PLATFORM_URL%/}/api/health"
echo
