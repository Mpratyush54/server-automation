# Pods evicted, node reports `DiskPressure`

## Symptom

```
kubectl get pods -A | grep Evicted
platform    platform-api-6d7c9f8-abc    0/1   Evicted   0   3m

kubectl describe node
  Conditions:
    DiskPressure   True    ...   Kubelet has disk pressure
```

New pods can't schedule, image pulls fail with `no space left on device`, and
the node keeps oscillating between `Ready` and `NotReady`.

## Root Cause

k3s stores everything under `/var/lib/rancher/k3s` — container images, the
etcd datastore, mounted volumes and pod filesystem overlays. When free space
on `/var` drops below the kubelet eviction threshold (default: 10%), the
kubelet evicts pods to reclaim space.

The most common causes on a Platform install:

- Old container images that were never cleaned up (previous `latest` tags)
- Prometheus TSDB grew past its retention window
- Loki chunks accumulated on the ephemeral disk instead of a PV
- Grafana `plugins/` cache
- MinIO backup bucket wasn't lifecycled

## Fix

### 1. See where the space actually went

```bash
sudo du -sh /var/lib/rancher/k3s/agent/containerd/* \
             /var/lib/rancher/k3s/storage/* \
             /var/log \
             /var/lib/docker 2>/dev/null | sort -h
```

### 2. Prune unreferenced container images

```bash
sudo k3s crictl rmi --prune
```

Typically frees 3-8 GB.

### 3. Shrink Prometheus retention

Bootstrap default is 30 days. Drop it if you don't need that long:

```bash
kubectl -n monitoring patch prometheus kube-prometheus-kube-prome-prometheus \
  --type='merge' \
  -p '{"spec":{"retention":"7d"}}'
```

### 4. Trim Grafana plugin cache

```bash
kubectl -n monitoring exec deploy/kube-prometheus-grafana -- \
  sh -c 'rm -rf /var/lib/grafana/plugins/*/dist/build/cache 2>/dev/null; du -sh /var/lib/grafana'
```

### 5. Add disk (real fix)

The pre-flight step refuses to run the bootstrap below 40 GB free on `/var`.
For production you want at least 200 GB. On most cloud providers you can
attach a data disk and remount `/var/lib/rancher/k3s`:

```bash
sudo systemctl stop k3s
sudo rsync -aHAX /var/lib/rancher/k3s/ /mnt/data/k3s/
echo "/mnt/data/k3s /var/lib/rancher/k3s none bind 0 0" | sudo tee -a /etc/fstab
sudo mount -a
sudo systemctl start k3s
```

## Verification

```bash
df -h /var
kubectl describe node | grep -A3 Conditions
```

Free space should be well above 15% and `DiskPressure` should be `False`.
