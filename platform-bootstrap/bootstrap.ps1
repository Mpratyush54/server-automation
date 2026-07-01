@echo off
:: Platform Bootstrap Script for Windows
:: Single-command server and cluster provisioning
setlocal enabledelayedexpansion

set PLATFORM_VERSION=1.0.0
set LOG_FILE=platform-bootstrap.log

echo [%date% %time%] Platform Bootstrap v%PLATFORM_VERSION% >> %LOG_FILE%
echo Starting provisioning...

:: --- Docker ---
where docker >nul 2>&1
if %errorlevel% equ 0 (
    echo Docker already installed
) else (
    echo Installing Docker Desktop...
    echo Downloading Docker Desktop installer...
    curl -fsSL -o docker-desktop-install.exe https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe
    start /wait docker-desktop-install.exe install --accept-license --quiet
    echo Docker Desktop installed
)

:: --- Kubernetes (k3d on Windows) ---
where kubectl >nul 2>&1
if %errorlevel% equ 0 (
    echo Kubernetes already installed
) else (
    echo Installing kubectl...
    curl -fsSL -o kubectl.exe https://dl.k8s.io/release/v1.29.0/bin/windows/amd64/kubectl.exe
    move /y kubectl.exe %USERPROFILE%\AppData\Local\Microsoft\WindowsApps\ >nul 2>&1
)

:: --- Helm ---
where helm >nul 2>&1
if %errorlevel% equ 0 (
    echo Helm already installed
) else (
    echo Installing Helm...
    curl -fsSL -o get-helm.ps1 https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
    powershell -ExecutionPolicy Bypass -File get-helm.ps1
    echo Helm installed
)

:: --- Create namespaces ---
kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace databases --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace storage --dry-run=client -o yaml | kubectl apply -f -

echo Platform Bootstrap completed!
echo Run kubectl get all -A to verify components.
