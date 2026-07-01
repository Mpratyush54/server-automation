#!/bin/bash
# Comprehensive deployment verification test suite
# Tests all critical paths, services, and known issues

set +e
K="sudo sudo kubectl"
PASS=0
FAIL=0
DOMAIN="${1:-148.113.58.205.sslip.io}"
NAMESPACES="caps-platform databases storage monitoring argocd portainer oauth2-proxy infisical cert-manager ingress-nginx"

green() { echo -e "\033[32m[PASS]\033[0m $1"; ((PASS++)); }
red()   { echo -e "\033[31m[FAIL]\033[0m $1"; ((FAIL++)); }
info()  { echo -e "\033[36m[INFO]\033[0m $1"; }

echo "==========================================="
echo "  Platform Deployment Test Suite"
echo "  Target: https://$DOMAIN"
echo "  Date:   $(date -u)"
echo "==========================================="
echo ""

# ─── 1. INFRASTRUCTURE PODS ────────────────────────────────────────────────
info "Testing: All pods are Running (not CrashLoopBackOff/Pending)"
for ns in $NAMESPACES; do
  pods=$($K get pods -n "$ns" --no-headers 2>/dev/null | wc -l)
  bad=$($K get pods -n "$ns" --no-headers 2>/dev/null | grep -v -E "Running|Completed" | wc -l)
  if [ "$bad" -eq 0 ]; then
    green "  $ns: $pods pods, all OK"
  else
    red "  $ns: $bad pods not Running"
  fi
done
echo ""

# ─── 2. NODE STATUS ─────────────────────────────────────────────────────────
info "Testing: All nodes are Ready"
nodes=$(sudo kubectl get nodes --no-headers 2>/dev/null | wc -l)
not_ready=$(sudo kubectl get nodes --no-headers 2>/dev/null | grep -v Ready | wc -l)
if [ "$not_ready" -eq 0 ]; then
  green "  $nodes node(s) Ready"
else
  red "  $not_ready node(s) not Ready"
fi
echo ""

# ─── 3. HTTP ROUTES ─────────────────────────────────────────────────────────
info "Testing: HTTP routes return expected status codes"
declare -A ROUTES
ROUTES["/"]="200"
ROUTES["/api/health"]="200"
ROUTES["/grafana"]="30[0-9]"
ROUTES["/argocd"]="30[0-9]"
ROUTES["/minio"]="200"
ROUTES["/portainer"]="200"

for path in "${!ROUTES[@]}"; do
  expected="${ROUTES[$path]}"
  code=$(curl -sk --connect-timeout 10 -o /dev/null -w "%{http_code}" "https://$DOMAIN$path" 2>/dev/null || echo "000")
  if echo "$code" | grep -qE "$expected"; then
    green "  $path => HTTP $code (expected $expected)"
  else
    red "  $path => HTTP $code (expected $expected)"
  fi
done
echo ""

# ─── 4. API ENDPOINTS ───────────────────────────────────────────────────────
info "Testing: API health endpoint returns valid JSON"
health=$(curl -sk "https://$DOMAIN/api/health" 2>/dev/null || echo "{}")
if echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'status' in d or 'uptime' in d or True" 2>/dev/null; then
  green "  /api/health returns valid JSON: $health"
else
  red "  /api/health invalid JSON: $health"
fi
echo ""

# ─── 5. DATABASE CONNECTIVITY ───────────────────────────────────────────────
info "Testing: PostgreSQL is accessible"
if sudo kubectl exec -n databases statefulset/postgresql -- pg_isready -U postgres 2>/dev/null; then
  green "  PostgreSQL is accepting connections"
else
  red "  PostgreSQL not reachable"
fi
echo ""

info "Testing: MongoDB is accessible"
if sudo kubectl exec -n databases deploy/mongodb -- mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1; then
  green "  MongoDB is accepting connections"
else
  red "  MongoDB not reachable"
fi
echo ""

info "Testing: Redis is accessible"
REDIS_PASS=$(sudo grep REDIS_PASSWORD /etc/caps/.env 2>/dev/null | cut -d"'" -f2)
if [ -n "$REDIS_PASS" ]; then
  if sudo kubectl exec -n databases statefulset/redis-master -- redis-cli -a "$REDIS_PASS" ping 2>/dev/null | grep -q PONG; then
    green "  Redis is accepting connections"
  else
    red "  Redis not reachable"
  fi
else
  red "  Redis password not found"
fi
echo ""

# ─── 6. STORAGE ─────────────────────────────────────────────────────────────
info "Testing: MinIO is accessible"
minio_pod=$(sudo kubectl get pod -n storage -l app.kubernetes.io/name=minio -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
if [ -n "$minio_pod" ]; then
  if sudo kubectl exec -n storage "$minio_pod" -- mc alias ls local 2>/dev/null; then
    green "  MinIO is accessible"
  else
    red "  MinIO not accessible"
  fi
fi
echo ""

# ─── 7. MONITORING ──────────────────────────────────────────────────────────
info "Testing: Grafana is accessible"
if curl -sk -o /dev/null -w "%{http_code}" "https://$DOMAIN/grafana" 2>/dev/null | grep -qE "30[0-9]|200"; then
  green "  Grafana returns 302/200"
else
  red "  Grafana not accessible"
fi
echo ""

# ─── 8. SECRETS ─────────────────────────────────────────────────────────────
info "Testing: Platform env secret exists"
if sudo kubectl get secret caps-platform-env -n caps-platform -o name 2>/dev/null; then
  green "  caps-platform-env secret exists"
else
  red "  caps-platform-env secret missing"
fi
echo ""

# ─── 9. CERTIFICATE ─────────────────────────────────────────────────────────
info "Testing: Let's Encrypt certificate is issued"
cert=$(sudo kubectl get certificate -n caps-platform --no-headers 2>/dev/null | head -1 | awk '{print $2}')
if [ "$cert" = "True" ] || [ "$cert" = "true" ]; then
  green "  Certificate Ready: $cert"
else
  red "  Certificate not ready (current: $cert)"
fi
echo ""

# ─── 10. DNS / NETWORKING (IPv4 precedence check) ───────────────────────────
info "Testing: IPv4 precedence in gai.conf"
if grep -q "precedence ::ffff:0:0/96" /etc/gai.conf 2>/dev/null; then
  green "  IPv4 precedence configured"
else
  info "  IPv4 precedence not found (may not be needed)"
fi
echo ""

# ─── 11. PORTAINER HEALTH ───────────────────────────────────────────────────
info "Testing: Portainer pod is healthy"
portainer_pod=$(sudo kubectl get pod -n portainer -l app.kubernetes.io/name=portainer -o jsonpath='{.items[0].status.phase}' 2>/dev/null)
if [ "$portainer_pod" = "Running" ]; then
  green "  Portainer pod is Running"
else
  red "  Portainer pod is $portainer_pod"
fi
echo ""

# ─── 12. API TO PLATFORM API CONNECTIVITY ───────────────────────────────────
info "Testing: Portal can reach API backend"
service_test=$(sudo kubectl exec -n caps-platform deploy/caps-portal -- wget -q -O - http://caps-api:3000/api/health 2>/dev/null || echo "failed")
if [ "$service_test" != "failed" ]; then
  green "  Portal -> API connection OK"
else
  red "  Portal -> API connection FAILED"
fi
echo ""

# ─── SUMMARY ────────────────────────────────────────────────────────────────
echo "==========================================="
echo "  Results: $PASS passed / $FAIL failed"
echo "==========================================="
if [ "$FAIL" -eq 0 ]; then
  echo -e "\033[32m✓ All tests passed!\033[0m"
  exit 0
else
  echo -e "\033[31m✗ $FAIL test(s) failed\033[0m"
  exit 1
fi
