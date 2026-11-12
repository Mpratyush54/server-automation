# High availability (ha profile)

The `ha` install profile (`PLATFORM_PROFILE=ha`) is the multi-node path: it
installs everything the `full` profile does, plus the HA wiring described on
this page. Multi-node k3s (embedded etcd, `platformctl join`) is tracked in #53;
this page currently covers **ingress HA** (#54).

Single-node profiles (`minimal`, `standard`, `full`) are not affected by
anything below: ingress-nginx stays a single Deployment behind k3s ServiceLB.

## Ingress HA

Ingress HA keeps the portal, the API and project apps reachable when the node
that receives traffic fails. Pick a mode with `INGRESS_HA_MODE`:

| Mode | Use it when |
| --- | --- |
| `vip` (default when `INGRESS_VIP` is set) | All nodes share one L2 subnet and the network accepts gratuitous ARP for an extra address on the NIC (bare metal, most on-premises hypervisors, some VPS providers with private networks). |
| `external` (default when `INGRESS_VIP` is empty) | The provider filters ARP for unknown addresses (common on public clouds and VPS), or you already run an external load balancer or health-checked DNS failover. |

### Settings

Set these in the environment of `platformctl provision`. On ha installs they are
persisted to `/etc/platform/.env`:

| Variable | Meaning |
| --- | --- |
| `PLATFORM_PROFILE=ha` | Selects the ha profile |
| `INGRESS_HA_MODE` | `vip` or `external` |
| `INGRESS_VIP` | Floating IPv4 address for the ingress LoadBalancer Service (required in `vip` mode) |
| `INGRESS_VIP_INTERFACE` | NIC that carries the VIP (default: the interface of the IPv4 default route) |
| `API_VIP` | Optional floating IPv4 address for the Kubernetes API (`vip` mode only) |

Example:

```bash
sudo PLATFORM_PROFILE=ha INGRESS_HA_MODE=vip INGRESS_VIP=10.0.0.50 API_VIP=10.0.0.51 \
  platformctl provision
```

Point the platform domain's DNS record (and `*.<domain>` if used) at
`INGRESS_VIP`, or at the public address your router or provider forwards to it.

### vip mode

**How it works.** platformctl deploys [kube-vip](https://kube-vip.io)
(`ghcr.io/kube-vip/kube-vip`, pinned in `platformctl/internal/versions`) as a
DaemonSet on control-plane nodes, in ARP mode with per-Service leader election.
The elected node binds `INGRESS_VIP` to its interface and announces it with
gratuitous ARP. k3s ServiceLB is disabled so it does not also claim the Service,
and the ingress-nginx Service carries `kube-vip.io/loadbalancerIPs: <INGRESS_VIP>`.

platformctl writes two files on the first server before k3s starts:

- `/etc/rancher/k3s/config.yaml.d/60-platform-ingress-ha.yaml`: `disable+: [servicelb]`
  and, with `API_VIP`, `tls-san+: [<API_VIP>]`.
- `/var/lib/rancher/k3s/server/manifests/platform-kube-vip.yaml`: kube-vip RBAC
  and DaemonSet, applied by the k3s auto-deploy controller.

**Requirements**

- `INGRESS_VIP` and `API_VIP` must be unused addresses inside the subnet of the
  VIP interface, must not be a node address, and must not be the subnet's
  network or broadcast address. `platformctl provision` checks this, and before
  kube-vip is first deployed it refuses a VIP that answers ping. ICMP can be
  filtered, so also make sure the address is outside any DHCP range.
- The network must accept gratuitous ARP and traffic for an address the
  provider did not assign. Many cloud and VPS networks drop it, and failover then
  silently does nothing. On those providers use the provider's floating IP or
  load balancer and `external` mode.
- Every node that should be able to hold the VIP must be a k3s server
  (control-plane); kube-vip does not run on agents.

**Failover.** kube-vip leases use a 5 s duration, 3 s renew deadline and 1 s
retry period. When the holder stops, another server takes the lease within about
5 seconds and announces the VIP, so clients see a gap well under 10 seconds.
Connections open on the failed node are lost; clients reconnect.

**Client IP preservation.** The ingress Service keeps
`externalTrafficPolicy: Local`, so ingress-nginx sees the real client address
(needed by the per-IP limits and the API's rate limiters). The trade-off: only a
node with a ready local ingress-nginx pod can serve the VIP. On the ha profile
ingress-nginx therefore runs as a **DaemonSet** (one controller per node), and
kube-vip, with per-Service election, only elects nodes that have a local ready
endpoint.

**API VIP.** With `API_VIP` set, kube-vip also holds a floating address for the
Kubernetes API on port 6443 (lease `plndr-cp-lock` in `kube-system`), and
`API_VIP` is added to the k3s serving certificate (`tls-san`). Additional
servers and agents can then join through `https://<API_VIP>:6443` instead of
one server's address (`platformctl join`, #53). Joining servers need the same
`config.yaml.d` fragment so all servers agree that ServiceLB is disabled.

### external mode

No kube-vip is installed and k3s ServiceLB stays enabled: every node answers on
80/443 with its own controller pod (ingress-nginx DaemonSet). Put one of these
in front of the nodes:

- **Health-checked DNS failover** (client IPs preserved because clients connect
  to the nodes directly):
  - Cloudflare Load Balancing: one pool with every node's public address, an
    HTTP monitor on `GET /healthz`, port 80, expected status 200, interval
    15-30 s.
  - Route 53: one health check per node (HTTP, port 80, path `/healthz`,
    request interval 10 s, failure threshold 2-3) and failover or multivalue
    answer records with a 60 s TTL.
- **External TCP load balancer** (cloud load balancer, HAProxy, keepalived pair)
  forwarding 80 and 443 to every node with the same health check.

`/healthz` on port 80 is answered by the ingress-nginx default server with 200
on every node; TCP 443 works as an alternative check. A load balancer that
terminates or NATs TCP connections hides the client address from ingress-nginx,
so every request appears to come from the load balancer, and the per-IP limits
then apply to the load balancer as a whole. platformctl does not configure PROXY
protocol. If client IPs matter, prefer DNS failover or a pass-through load
balancer that preserves the source address.

### Firewall

The host firewall (`platformctl harden`, see [host hardening](../host-hardening.md))
already accepts TCP 80/443 to any local address, including a VIP, and forwards
connections whose original destination port is 80/443 (kube-proxy translates the
VIP to the local ingress-nginx pod). ARP is not filtered by it. With `API_VIP`
set, hardening also accepts TCP 6443 to `API_VIP` from the node subnet.
Hardening currently runs only while the cluster has one node; firewall rules
between nodes (etcd, flannel, kubelet, 6443/9345) are part of #53.

### TLS certificates

cert-manager's HTTP-01 challenges arrive at whichever node serves the VIP (or
passes the external health check). Every node runs a controller with the same
configuration, so issuance and renewal work regardless of which node answers.

### Verify

```bash
# Which node holds the ingress VIP (and the API VIP lease, if enabled)
kubectl -n kube-system get lease | grep -i -e kubevip -e plndr
kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-vip -o wide
ip -4 addr show dev <iface>        # on the holder: INGRESS_VIP/32 is listed
kubectl -n ingress-nginx get svc ingress-nginx-controller   # EXTERNAL-IP = INGRESS_VIP
kubectl -n ingress-nginx get ds                             # one controller per node

# Failover: from a client outside the cluster, keep requesting the portal...
while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" --max-time 2 https://<domain>/; sleep 0.5; done
# ...and power off the node holding the VIP. Expect at most a few seconds of errors.
```

### Switching modes

Set the new values explicitly (including `INGRESS_HA_MODE`, which is persisted
in `/etc/platform/.env` and otherwise keeps its previous value) and run
`platformctl provision` again:

- `external` to `vip`: the fragment disables ServiceLB, k3s restarts, the
  leftover ServiceLB (`svclb-*`) DaemonSets are deleted and kube-vip takes over
  the Service address.
- `vip` to `external`: the fragment and the kube-vip manifest are removed, k3s
  restarts with ServiceLB enabled, and the `kube-vip-ds` DaemonSet is deleted.

### Out of scope

Anycast or global load balancing, BGP mode, and automating a provider's
floating-IP API.
