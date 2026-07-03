# =============================================================================
# Platform - Windows bootstrap launcher
#
# The Platform runs on Kubernetes (k3s), which only ships on Linux.
# On Windows we can't install k3s natively - the right move is to run the
# real bootstrap.sh inside WSL2. This script:
#
#   1. Checks WSL2 is installed (installs it if not).
#   2. Makes sure Ubuntu 22.04+ is available as a WSL distro.
#   3. Runs bootstrap.sh inside that Ubuntu distro.
#
# If you just want to develop against the Platform locally on Windows, you
# do NOT need this script - use docker-compose from the repo root instead:
#
#   docker compose up -d postgres mongodb redis
#   npm run start
#
# =============================================================================

$ErrorActionPreference = 'Stop'

function Write-Info    { param($m) Write-Host "[Platform] $m" -ForegroundColor Cyan }
function Write-Success { param($m) Write-Host "[Platform] $m" -ForegroundColor Green }
function Write-Warn    { param($m) Write-Host "[Platform] $m" -ForegroundColor Yellow }
function Write-Err     { param($m) Write-Host "[Platform] $m" -ForegroundColor Red; exit 1 }

Write-Info 'Platform Windows launcher'
Write-Info 'The full Platform requires Linux (k3s). We will use WSL2.'
Write-Host ''

# --- Elevation check -------------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err 'Please run this script from an *elevated* PowerShell (Right-click - Run as Administrator).'
}

# --- 1. WSL --------------------------------------------------------------
Write-Info 'Checking WSL2 status...'
$wslInstalled = $false
try {
    $null = wsl.exe --status 2>&1
    if ($LASTEXITCODE -eq 0) { $wslInstalled = $true }
} catch { $wslInstalled = $false }

if (-not $wslInstalled) {
    Write-Warn 'WSL2 is not installed. Installing now (this will reboot your machine).'
    wsl.exe --install --no-launch
    Write-Warn 'WSL2 installed. Reboot Windows and re-run this script.'
    exit 0
}

# --- 2. Ubuntu distro ---------------------------------------------------
Write-Info 'Checking for an Ubuntu WSL distro...'
$distros = wsl.exe --list --quiet 2>$null | Where-Object { $_ -match 'Ubuntu' }
if (-not $distros) {
    Write-Warn 'No Ubuntu distro found. Installing Ubuntu-22.04...'
    wsl.exe --install -d Ubuntu-22.04 --no-launch
    Write-Warn 'Ubuntu-22.04 installed. Launch it once from Start Menu to create your user, then re-run this script.'
    exit 0
}
Write-Success "Found WSL distro(s): $($distros -join ', ')"

# --- 3. Run bootstrap.sh inside WSL ------------------------------------
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$bootstrap  = Join-Path $scriptDir 'bootstrap.sh'

if (-not (Test-Path $bootstrap)) {
    Write-Err "Could not find bootstrap.sh in $scriptDir. Make sure you're running this from the platform-bootstrap directory."
}

# Convert C:\path\to\bootstrap.sh -> /mnt/c/path/to/bootstrap.sh
$wslPath = $bootstrap -replace '^([A-Za-z]):\\', { '/mnt/' + $_.Groups[1].Value.ToLower() + '/' } -replace '\\', '/'

Write-Info "Launching bootstrap.sh inside WSL: $wslPath"
Write-Warn 'You will be prompted for the sudo password of your WSL user.'
Write-Host ''
wsl.exe -- bash -c "chmod +x '$wslPath' && sudo '$wslPath'"

if ($LASTEXITCODE -ne 0) {
    Write-Err "bootstrap.sh exited with code $LASTEXITCODE. See /var/log/platform-bootstrap.log inside WSL."
}

Write-Success 'Bootstrap finished. Read the summary above for URLs and credentials.'
