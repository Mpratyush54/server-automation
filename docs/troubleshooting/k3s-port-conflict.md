# k3s fails to start — port 6443, 80, or 443 already in use

## Symptom

```
[INFO]  systemd: Starting k3s
[ERROR] listen tcp :6443: bind: address already in use
```

Or the k3s service starts but `kubectl get nodes` hangs, and ingress-nginx pods
crash-loop with `bind: address already in use`.

## Root Cause

k3s wants:

- **:6443** for the Kubernetes API server
- **:80 / :443** for the bundled Traefik ingress (Traefik is disabled by our
  bootstrap in favour of ingress-nginx, but ingress-nginx still needs 80/443
  free)
- **:10250** for the kubelet

Anything already bound to those ports stops k3s from installing correctly.
Common culprits:

| Port | Usually |
|---|---|
| 80/443 | `apache2`, `nginx`, `caddy`, `docker-proxy` from a previous compose stack |
| 6443 | Another k3s / kubeadm cluster left over from an earlier attempt |
| 10250 | An abandoned kubelet from a previous install |

## Fix

### 1. Find what's using the port

```bash
sudo ss -tlnp '( sport = :80 or sport = :443 or sport = :6443 or sport = :10250 )'
```

You'll get a line per offending service — the last column is the process.

### 2. Stop or remove the conflicting service

```bash
# Common cases:
sudo systemctl disable --now apache2
sudo systemctl disable --now nginx
sudo systemctl disable --now caddy

# A stale k3s from a previous attempt:
sudo /usr/local/bin/k3s-uninstall.sh || true

# Old Docker compose stack:
docker compose down
```

### 3. Free port 6443 if it's a leftover k3s

```bash
# If :6443 is bound by a k3s process, wipe it fully
sudo /usr/local/bin/k3s-uninstall.sh 2>/dev/null || true
sudo rm -rf /etc/rancher /var/lib/rancher/k3s /var/lib/kubelet
```

### 4. Re-run the bootstrap

```bash
sudo sed -i '/^k3s=/d;/^ingress=/d' /etc/platform/.bootstrap_state
sudo ./platform-bootstrap/bootstrap.sh
```

The pre-flight step will fail fast now if the port is still occupied — that's
the intended behaviour.

## Verification

```bash
sudo ss -tlnp '( sport = :80 or sport = :443 or sport = :6443 )'
# expect: only k3s / ingress-nginx-controller
kubectl get nodes
# expect: node in Ready state
```
