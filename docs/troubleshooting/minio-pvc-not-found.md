# MinIO — Pod stuck in Init / ContainerCreating (PVC not found)

## Symptom

> MinIO pod is stuck in `Init:0/1` or `ContainerCreating` state. Describe shows `persistentvolumeclaim "minio-pvc" not found`.

## Root Cause

The PersistentVolumeClaim (PVC) that MinIO expects is not bound. This can happen when:
- The PVC was deleted accidentally.
- No StorageClass exists that can dynamically provision the volume.
- The PVC is stuck in `Pending` because the cluster has no provisioner.

## Fix

### 1. Check PVC and StorageClass status

```bash
kubectl get pvc -n minio
kubectl get sc
kubectl describe pvc <pvc-name> -n minio
```

If the PVC is stuck in `Pending`, note the `storage-class` name.

### 2. Create a StorageClass if missing

If no StorageClass exists, create one (example for `local-path` provisioner used by k3s/k3d):

```bash
cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
provisioner: rancher.io/local-path
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
EOF
```

> Adjust the `provisioner` to match your cluster (e.g., `ebs.csi.aws.com` on EKS, `pd.csi.storage.gke.io` on GKE).

### 3. Delete and recreate the MinIO Helm release

```bash
helm uninstall minio -n minio
```

If the PVC is the problem, delete it too:

```bash
kubectl delete pvc --all -n minio
```

Reinstall MinIO:

```bash
helm upgrade --install minio bitnami/minio \
  --namespace minio --create-namespace \
  --set persistence.storageClass=local-path \
  --set persistence.size=10Gi \
  --set auth.rootUser=admin \
  --set auth.rootPassword=<password>
```

## Verification

```bash
kubectl get pods -n minio -w
```

Wait until the pod reaches `Running` state. Then verify the PVC is bound:

```bash
kubectl get pvc -n minio
```

Expected output — PVC shows `Bound` status.
