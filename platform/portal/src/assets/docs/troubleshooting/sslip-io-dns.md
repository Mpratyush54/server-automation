# `sslip.io` name won't resolve inside the cluster — `server misbehaving`

## Symptom

Anything trying to reach an `sslip.io` hostname from inside the cluster fails
with one of:

```
dial tcp: lookup argocd.YOUR_SERVER_IP.sslip.io on 10.43.0.10:53: server misbehaving
Get "https://.../.well-known/openid-configuration": lookup ... server misbehaving
```

Externally the hostname works fine — `nslookup argocd.YOUR_SERVER_IP.sslip.io`
from your laptop returns `YOUR_SERVER_IP`. The break is inside CoreDNS.

## Root Cause

CoreDNS by default forwards to `/etc/resolv.conf`, which on Ubuntu points at
`127.0.0.53` (`systemd-resolved`'s stub resolver). That stub is on the **host's**
network namespace and is unreachable from inside the CoreDNS pod. sslip.io only
resolves through a real upstream (Google DNS, Cloudflare) — so from the pod's
point of view every sslip.io lookup fails.

Compounding this, when Platform runs on a bare IP + sslip.io, we want internal
services (ArgoCD, Grafana, Portainer …) to hit the *ingress controller* by name,
not go out to the internet and come back.

## Fix

The bootstrap already applies this patch during Phase 4 (`install_kubernetes`).
If you skipped the bootstrap or restored an older CoreDNS ConfigMap, re-apply it
manually.

### 1. Point CoreDNS at real upstream DNS + rewrite `$DOMAIN` to the ingress

Edit the `Corefile` inside the `coredns` ConfigMap:

```bash
kubectl -n kube-system edit configmap coredns
```

Replace the `forward . /etc/resolv.conf` line with real resolvers and add rewrite
rules for your domain (replace `YOUR_SERVER_IP.sslip.io` with your own):

```
.:53 {
    errors
    health
    ready

    # Send *.<your-domain> and <your-domain> itself to the ingress controller.
    # Escape every dot in the regex. For an sslip.io install with the IP
    # 203.0.113.10, the domain literal is "203.0.113.10.sslip.io" and the
    # regex becomes: (.*)\.203\.0\.113\.10\.sslip\.io
    rewrite name regex (.*)\.YOUR_SERVER_IP\.sslip\.io ingress-nginx-controller.ingress-nginx.svc.cluster.local
    rewrite name YOUR_SERVER_IP.sslip.io ingress-nginx-controller.ingress-nginx.svc.cluster.local

    kubernetes cluster.local in-addr.arpa ip6.arpa {
      pods insecure
      fallthrough in-addr.arpa ip6.arpa
    }

    prometheus :9153
    forward . 8.8.8.8 8.8.4.4
    cache 30
    loop
    reload
    loadbalance
}
```

### 2. Restart CoreDNS

```bash
kubectl -n kube-system rollout restart deployment/coredns
kubectl -n kube-system rollout status  deployment/coredns
```

## Verification

```bash
# From inside the cluster
kubectl -n platform run dns-test --rm -it --restart=Never --image=busybox:1.36 -- \
  nslookup argocd.YOUR_SERVER_IP.sslip.io

# Expected: resolves to the ingress-nginx-controller ClusterIP
```

You should also be able to hit any subdomain from inside the cluster:

```bash
kubectl -n platform run curl-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sk -o /dev/null -w "%{http_code}\n" https://argocd.YOUR_SERVER_IP.sslip.io/
```

An HTTP status (301/302/200) means DNS + routing are healthy.
