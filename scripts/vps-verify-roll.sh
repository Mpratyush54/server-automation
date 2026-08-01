#!/bin/bash
set -euo pipefail
echo "=== images ==="
sudo k3s kubectl -n platform get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,POLICY:.spec.template.spec.containers[0].imagePullPolicy
echo "=== api symbols ==="
sudo k3s kubectl -n platform exec deploy/platform-api -- sh -c 'ls dist/lib/git-remote.js; grep -c "git/releases" dist/routes/projects.js; grep -c projectIdMongoFilter dist/routes/sdk.js || true'
echo "=== portal bundle strings ==="
curl -sk https://148.113.59.3.sslip.io/ -o /tmp/portal.html
JS=$(grep -oE 'main-[A-Za-z0-9]+\.js' /tmp/portal.html | head -1)
echo "bundle=$JS"
curl -sk "https://148.113.59.3.sslip.io/$JS" -o /tmp/main.js
grep -oE 'Pull from GitHub|GitHub Releases|Update to|feature/CU-123-auth|Deploy Service' /tmp/main.js | sort -u || true
echo "=== auto-update ==="
sudo k3s kubectl -n platform get cronjob platform-auto-update -o jsonpath='suspend={.spec.suspend}{"\n"}' 2>/dev/null || echo no-cron
echo "=== health ==="
curl -sk https://api.148.113.59.3.sslip.io/api/health || curl -sk https://148.113.59.3.sslip.io/api/health || true
echo
