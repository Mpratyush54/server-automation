# Start Node + React + Angular SDK demos against the live platform.
# Usage (PowerShell):
#   $env:PLATFORM_SDK_TOKEN='sdk_live_...'
#   ./start-demos.ps1
# Or pass -Token

param(
  [string]$Token = $env:PLATFORM_SDK_TOKEN,
  [string]$ProjectName = $(if ($env:PROJECT_NAME) { $env:PROJECT_NAME } else { 'sdk-demo-apps' }),
  [string]$PlatformUrl = $env:PLATFORM_URL,
  [string]$ProjectDomain = $env:PROJECT_DOMAIN
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$env:PLATFORM_URL = $PlatformUrl
$env:PROJECT_DOMAIN = $ProjectDomain
node -e "require(process.argv[1]).readConfig()" "$root/node-api/src/config.cjs"
if ($LASTEXITCODE -ne 0) { throw 'Set PLATFORM_URL and PROJECT_DOMAIN before starting demos.' }

if (-not $Token -and (Test-Path "$root\.demo-env.json")) {
  $cfg = Get-Content "$root\.demo-env.json" -Raw | ConvertFrom-Json
  $Token = $cfg.sdkToken
  if ($cfg.demoProjectName) { $ProjectName = $cfg.demoProjectName }
}

if (-not $Token) {
  Write-Error "PLATFORM_SDK_TOKEN required (create one in portal → project → SDK tokens)"
}

Write-Host "Starting node-api :4100  project=$ProjectName"
# TLS verification stays on; set $env:NODE_EXTRA_CA_CERTS to trust a lab CA (inherited by the child process).
$env:PLATFORM_SDK_TOKEN = $Token
$env:PROJECT_NAME = $ProjectName
$env:PORT = '4100'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory "$root\node-api" -WindowStyle Minimized

Start-Sleep -Seconds 3

Write-Host "Starting react-web :5173"
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' -WorkingDirectory "$root\react-web" -WindowStyle Minimized

Write-Host "Starting angular-web :4200"
$angCmd = 'set PORT=&& set ANGULAR_PORT=4200&& set API_URL=http://127.0.0.1:4100&& npm start'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $angCmd -WorkingDirectory "$root\angular-web" -WindowStyle Minimized

Write-Host ""
Write-Host "Demos:"
Write-Host "  React   http://127.0.0.1:5173"
Write-Host "  Angular http://127.0.0.1:4200"
Write-Host "  Node    http://127.0.0.1:4100/health"
Write-Host "Portal project: $ProjectName → Metrics / API Latency"
