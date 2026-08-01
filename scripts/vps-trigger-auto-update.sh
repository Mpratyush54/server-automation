#!/bin/bash
set -euo pipefail
JOB="platform-auto-update-manual-$(date +%s)"
sudo kubectl -n platform create job --from=cronjob/platform-auto-update "$JOB"
echo "created:$JOB"
sudo kubectl -n platform wait --for=condition=complete "job/$JOB" --timeout=300s
echo "=== job logs ==="
sudo kubectl -n platform logs "job/$JOB" --tail=40
echo "=== platform pods ==="
sudo kubectl -n platform get pods
echo "=== images ==="
sudo kubectl -n platform get deploy platform-api platform-portal -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,PULL:.spec.template.spec.containers[0].imagePullPolicy
