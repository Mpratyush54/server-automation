#!/bin/bash
# Platform - Kubeconfig Setup Script
# Run this on the K8s master node to set up kubeconfig for Platform

set -e

KUBECONFIG_DIR="$HOME/.kube"
KUBECONFIG_FILE="$KUBECONFIG_DIR/config"
PLATFORM_API_DIR="$(dirname "$0")/.."

echo "=== Platform Kubeconfig Setup ==="

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "ERROR: kubectl not found. Install kubectl first."
    exit 1
fi

# Check if we're running as root
if [ "$EUID" -ne 0 ]; then
    echo "WARNING: Running without root. Some operations may fail."
fi

# Create .kube directory if it doesn't exist
mkdir -p "$KUBECONFIG_DIR"

# If running on the master node, copy from /etc/kubernetes/admin.conf
if [ -f /etc/kubernetes/admin.conf ]; then
    echo "Found admin.conf on master node. Copying..."
    cp /etc/kubernetes/admin.conf "$KUBECONFIG_FILE"
    chmod 600 "$KUBECONFIG_FILE"
    echo "Kubeconfig copied to $KUBECONFIG_FILE"
else
    echo "admin.conf not found. Please provide kubeconfig manually:"
    echo ""
    echo "  Option 1: Copy from your existing kubeconfig:"
    echo "    cp /path/to/your/kubeconfig $KUBECONFIG_FILE"
    echo ""
    echo "  Option 2: Use kubectl config view to generate:"
    echo "    kubectl config view --minify > $KUBECONFIG_FILE"
    echo ""
    echo "  Option 3: Set KUBECONFIG environment variable:"
    echo "    export KUBECONFIG=/path/to/your/kubeconfig"
    echo ""
    exit 1
fi

# Verify connection
echo "Verifying Kubernetes connection..."
if kubectl cluster-info; then
    echo "✓ Kubernetes connection successful"
else
    echo "ERROR: Cannot connect to Kubernetes cluster"
    exit 1
fi

# Show cluster info
echo ""
echo "=== Cluster Info ==="
kubectl get nodes -o wide
echo ""

# Create Platform namespace if it doesn't exist
echo "Creating Platform namespace..."
kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -
echo "✓ Namespace platform ready"

# Create preview namespace
echo "Creating preview namespace..."
kubectl create namespace preview --dry-run=client -o yaml | kubectl apply -f -
echo "✓ Namespace preview ready"

echo ""
echo "=== Setup Complete ==="
echo "Kubeconfig: $KUBECONFIG_FILE"
echo "Kubernetes: $(kubectl cluster-info 2>&1 | head -1)"
echo ""
echo "Add to your .env file:"
echo "  KUBECONFIG=$KUBECONFIG_FILE"
