# External deployment test suite (run from Windows)
$global:Pass = 0; $global:Fail = 0
$Domain = "148.113.58.205.sslip.io"

function Test-Pass($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green; $global:Pass++ }
function Test-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; $global:Fail++ }
function Test-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }

Write-Host "===========================================" -ForegroundColor Magenta
Write-Host "  Platform External Test Suite" -ForegroundColor Magenta
Write-Host "  Target: https://$Domain" -ForegroundColor Magenta
Write-Host "  Date:   $(Get-Date -Format u)" -ForegroundColor Magenta
Write-Host "===========================================" -ForegroundColor Magenta
Write-Host ""

# 1. Portal
Test-Info "Testing: Portal returns 200"
$r = curl.exe -sk -o NUL -w "%{http_code}" "https://$Domain/"
if ($r -eq "200") { Test-Pass "Portal => HTTP 200" } else { Test-Fail "Portal => HTTP $r" }

# 2. API Health
Test-Info "Testing: API Health returns 200"
$r = curl.exe -sk -o NUL -w "%{http_code}" "https://$Domain/api/health"
if ($r -eq "200") { Test-Pass "API Health => HTTP 200" } else { Test-Fail "API Health => HTTP $r" }

# 3. Grafana
Test-Info "Testing: Grafana returns redirect (302)"
$r = curl.exe -sk -o NUL -w "%{http_code}" "https://$Domain/grafana"
if ($r -match "30[0-9]") { Test-Pass "Grafana => HTTP $r (redirect)" } else { Test-Fail "Grafana => HTTP $r" }

# 4. ArgoCD
Test-Info "Testing: ArgoCD returns redirect (307)"
$r = curl.exe -sk -o NUL -w "%{http_code}" "https://$Domain/argocd"
if ($r -match "30[0-9]") { Test-Pass "ArgoCD => HTTP $r (redirect)" } else { Test-Fail "ArgoCD => HTTP $r" }

# 5. MinIO
Test-Info "Testing: MinIO returns 200"
$r = curl.exe -sk -o NUL -w "%{http_code}" "https://$Domain/minio"
if ($r -eq "200") { Test-Pass "MinIO => HTTP 200" } else { Test-Fail "MinIO => HTTP $r" }

# 6. Portainer
Test-Info "Testing: Portainer returns 200"
$r = curl.exe -sk -o NUL -w "%{http_code}" "https://$Domain/portainer"
if ($r -eq "200") { Test-Pass "Portainer => HTTP 200" } else { Test-Fail "Portainer => HTTP $r" }

# 7. API response content
Test-Info "Testing: API health response is valid JSON"
$body = curl.exe -sk "https://$Domain/api/health"
try { $null = $body | ConvertFrom-Json; Test-Pass "API health returns valid JSON" }
catch { Test-Fail "API health invalid JSON: $body" }

# Summary
Write-Host ""
Write-Host "===========================================" -ForegroundColor Magenta
Write-Host "  Results: $Pass passed / $Fail failed" -ForegroundColor Magenta
Write-Host "===========================================" -ForegroundColor Magenta
if ($Fail -eq 0) { Write-Host "All tests passed!" -ForegroundColor Green } else { Write-Host "$Fail test(s) failed" -ForegroundColor Red }
