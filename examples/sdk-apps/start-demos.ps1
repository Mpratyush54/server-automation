# Start Node + React + Angular SDK demos against the live platform.
# Usage (PowerShell):
#   $env:PLATFORM_SDK_TOKEN='sdk_live_...'
#   ./start-demos.ps1
# Or pass -Token

param(
  [string]$Token = $env:PLATFORM_SDK_TOKEN,
  [string]$ProjectName = $(if ($env:PROJECT_NAME) { $env:PROJECT_NAME } else { 'sdk-demo-apps' }),
  [string]$PlatformUrl = $(if ($env:PLATFORM_URL) { $env:PLATFORM_URL } else { 'https://api.148.113.59.3.sslip.io' })
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Token -and (Test-Path "$root\.demo-env.json")) {
  $cfg = Get-Content "$root\.demo-env.json" -Raw | ConvertFrom-Json
  $Token = $cfg.sdkToken
  if ($cfg.demoProjectName) { $ProjectName = $cfg.demoProjectName }
}

if (-not $Token) {
  Write-Error "PLATFORM_SDK_TOKEN required (create one in portal → project → SDK tokens)"
}

Write-Host "Starting node-api :4100  project=$ProjectName"
$nodeCmd = "set NODE_TLS_REJECT_UNAUTHORIZED=0&& set PLATFORM_SDK_TOKEN=$Token&& set PLATFORM_URL=$PlatformUrl&& set PROJECT_NAME=$ProjectName&& set PORT=4100&& npm start"
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $nodeCmd -WorkingDirectory "$root\node-api" -WindowStyle Minimized

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
