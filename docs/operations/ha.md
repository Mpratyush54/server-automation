# High availability (ha profile)

The `ha` install profile (`PLATFORM_PROFILE=ha`) runs the platform on several
nodes. It installs everything the `full` profile does, plus three HA layers that
this page covers in order:

1. **Cluster**: k3s keeps the cluster state in **embedded etcd** replicated
   across the server nodes, so the Kubernetes API keeps working when one server
   is lost. Extra **agent** nodes add workload capacity.
2. **Ingress HA**: the portal, the API and project apps stay reachable when the
   node that receives traffic fails (kube-vip floating IP, or an external load
   balancer / DNS failover).
3. **Replicated storage**: Longhorn replicates every PersistentVolume across
   nodes and is the default StorageClass.

Single-node profiles (`minimal`, `standard`, `full`) are not affected by
anything on this page: they keep a single-node k3s, k3s local-path storage and
a single ingress-nginx Deployment behind k3s ServiceLB.

## Overview and requirements

### Topology

| Servers | Tolerates losing | Notes |
|---|---|---|
| 1 | 0 | Not HA. `platformctl status` warns until 3 servers have joined |
| 2 | 0 | **Not HA**: losing either server loses etcd quorum |
| 3 | 1 | Recommended minimum |
| 4 | 1 | An even count adds no fault tolerance; use 5 instead |
| 5 | 2 | |

etcd needs a majority of servers (`n/2 + 1`) to accept writes. Use an odd number
of servers (3 or 5). Agents do not run etcd and do not count towards quorum.

### Node requirements

- Ubuntu 22.04+ with the same requirements as a single-node install.
- Synchronised clocks (chrony is installed by host hardening).
- A private network between the nodes is strongly recommended. Ingress `vip`
  mode needs all servers in one L2 subnet.
- Roughly 500 MB or more RAM per node for the storage services, plus disk
  overhead for Longhorn replicas, snapshots and rebuilds.
- The same platformctl release on every node.

### Ports between nodes

| Port | Protocol | Purpose | Needed on |
|---|---|---|---|
| 6443 | TCP | Kubernetes API and k3s supervisor (node join) | servers |
| 2379, 2380 | TCP | etcd client and peer traffic | servers |
| 10250 | TCP | kubelet (logs, exec, metrics) | all nodes |
| 8472 | UDP | flannel VXLAN pod network | all nodes |

With host hardening enabled (the default), platformctl opens these ports **only
to the addresses in `PLATFORM_CLUSTER_NODES`** on every node. Everything else
stays as on a single node: 22/80/443 are public, everything else is dropped.
With `API_VIP` set, hardening also accepts TCP 6443 to `API_VIP` from the node
subnet. Longhorn needs no extra ports: its traffic stays on the pod network and
iSCSI is node-local. Cloud security groups must allow the same ports between
the nodes. See [Host hardening](../host-hardening.md).

### Settings at a glance

| Variable | Layer | Meaning |
|---|---|---|
| `PLATFORM_PROFILE=ha` | all | Selects the ha profile |
| `PLATFORM_CLUSTER_NODES` | cluster | Every node's IP, or the private subnet CIDR (firewall peers) |
| `PLATFORM_API_SANS` | cluster | Extra DNS names/IPs for the Kubernetes API certificate |
| `PLATFORM_NODE_IP` | cluster | Private address k3s advertises for this node |
| `ETCD_*` | cluster | etcd snapshot schedule and S3 target ([below](#etcd-snapshots)) |
| `INGRESS_HA_MODE` | ingress | `vip` or `external` |
| `INGRESS_VIP` | ingress | Floating IPv4 address for the ingress LoadBalancer Service (required in `vip` mode) |
| `INGRESS_VIP_INTERFACE` | ingress | NIC that carries the VIP; must have this name on every server (unset: kube-vip uses each node's default-route interface) |
| `API_VIP` | ingress | Optional floating IPv4 address for the Kubernetes API (`vip` mode only) |
| `LONGHORN_REPLICAS` | storage | `1`, `2` or `3`; unset = automatic |
| `LONGHORN_BACKUP_TARGET` / `LONGHORN_BACKUP_SECRET` | storage | Longhorn S3 backup target and credentials Secret name |

They are persisted to `/etc/platform/.env`, so re-running `provision` keeps them.

## Cluster: k3s HA, join and tokens

### 1. First server

```bash
export PLATFORM_CLUSTER_NODES=10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21   # every node (IPs or a CIDR such as 10.0.0.0/24)
export PLATFORM_API_SANS=k8s.example.com                                  # optional: API DNS name
export PLATFORM_NODE_IP=10.0.0.11                                          # optional: private address to advertise
export INGRESS_HA_MODE=vip INGRESS_VIP=10.0.0.50 API_VIP=10.0.0.60         # see Ingress HA below
sudo -E platformctl provision --profile ha
```

Provision on the first server, in order:

1. writes the ingress HA k3s config fragment and the kube-vip manifest
   (`ingress-ha` step, before k3s starts);
2. starts k3s with `cluster-init` (embedded etcd), Secrets encryption and the
   TLS SANs (`PLATFORM_API_SANS`, plus `API_VIP` from the fragment);
3. installs Longhorn and makes it the default StorageClass before any workload
   creates a PersistentVolumeClaim;
4. installs the platform as usual (ingress-nginx runs as a DaemonSet).

platformctl generates the cluster tokens before k3s starts and keeps them in
`/etc/platform/k3s/` (mode 0600): `server-token` joins servers, `agent-token`
joins agents. An existing single-node install switched to `--profile ha` keeps its
current k3s token and is converted from SQLite to etcd on the k3s restart; take a
backup (`platformctl backup --all`) first.

`PLATFORM_CLUSTER_NODES` is required while host hardening is enabled: without it the
firewall would block the other nodes. List all planned nodes up front, or use the
private subnet CIDR. To add a node later, add its IP on every existing node and run
`sudo platformctl harden --auto` there.

### 2. Create a join token

On the first server:

```bash
# Server token (joins servers). Written to a 0600 file, never printed to logs.
# --settings-output also writes the cluster's join settings (no secrets).
sudo platformctl token create --role server --output /root/server.token \
  --settings-output /root/join-settings

# Agent token: an expiring bootstrap token (recommended) ...
sudo platformctl token create --role agent --ttl 2h --output /root/agent.token
# ... or the static agent token
sudo platformctl token create --role agent --output /root/agent.token
```

Without `--output` the token is printed once to standard output. Tokens use the
k3s secure format (`K10<ca-hash>::...`): the joining node checks the cluster's CA
against the hash before it sends any credential. Copy the file to the new node
over SSH (`scp`) and delete it afterwards.

The join settings file holds only the cluster's ingress HA settings, as
`KEY=VALUE` lines under a `# platformctl join settings v1` header:

```
# platformctl join settings v1
# Cluster ingress HA settings for `platformctl join --role server --join-settings <file>`. No secrets.
INGRESS_HA_MODE=vip
INGRESS_VIP=10.0.0.50
INGRESS_VIP_INTERFACE=
API_VIP=10.0.0.60
```

Without `--settings-output`, `token create --role server` prints the same
block on standard error (standard output carries only the token). Copy the
file to new servers with the token. It is not secret, but keep it with the
token so the two describe the same cluster. Agents need no settings file.

### 3. Join servers and agents

On each new node (fresh Ubuntu, `platformctl` installed with `install.sh`),
give servers the **same ingress HA settings as the first server** (all servers
must agree on them, see below) and join through the API VIP:

```bash
# second and third server
sudo platformctl join --role server --server https://10.0.0.60:6443 \
  --token-file /root/server.token --join-settings /root/join-settings \
  --ingress-ha-mode vip --ingress-vip 10.0.0.50 --api-vip 10.0.0.60 \
  --nodes 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21

# agent (no ingress HA settings)
sudo platformctl join --role agent --server https://10.0.0.60:6443 \
  --token-file /root/agent.token --nodes 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21
```

The ingress flags default to `INGRESS_HA_MODE`, `INGRESS_VIP`,
`INGRESS_VIP_INTERFACE` and `API_VIP` from the environment, so
`export ...; sudo -E platformctl join ...` works too. A `--ingress-vip` given
without a mode selects `vip` mode, as `INGRESS_VIP` does.

With `--join-settings`, a joining server compares its own settings with the
file before it changes anything on the host, and stops when they differ:

```
Error: this server's ingress HA settings differ from the cluster's (k3s would refuse the server, or kube-vip would be configured differently):
    INGRESS_HA_MODE: cluster "vip", this node "external"
  set --ingress-ha-mode, --ingress-vip, --ingress-vip-interface and --api-vip (or the matching environment variables) to the values in /root/join-settings
```

In `vip` mode all four values must match (the VIPs and interface also end up
in the kube-vip manifest, which must be identical on every server); in
`external` mode only the mode is compared. A joining node has no credentials
for the cluster API before k3s runs, so this file is how it learns the
cluster's settings. Without `--join-settings`, `join` warns and uses its own
settings unchecked; a mismatched mode then surfaces only as k3s refusing to
start ("critical configuration value mismatch"). `--join-settings` is ignored
for agents.

`--server` takes `https://<API_VIP>:6443` (recommended once `API_VIP` is set:
the join, and the node's later reconnects, then do not depend on the first
server), a DNS name from `PLATFORM_API_SANS` that points at the servers, or
`https://<first server IP>:6443` (external mode without such a name).
`--token-file -` reads the token from standard input
(`ssh first-server sudo platformctl token create --role agent --ttl 1h | sudo platformctl join ... --token-file -`).
The token is never accepted on the command line, where other users could read
it, and is never printed or logged.

Before changing anything, `join` checks:

- the ports above are reachable on the server (6443/10250, plus 2379/2380 for
  servers; through the API VIP the etcd ports are not dialled, because etcd
  listens on node addresses only, and `join` warns instead);
- the token belongs to that cluster (CA hash);
- the clock is synchronised and within 5 s of the server;
- the cluster runs the k3s version this platformctl installs (use the same
  platformctl release on every node);
- the local k3s ports are free.

Then, **before k3s starts**, it prepares the node like the first server:

| Step | Servers | Agents |
|---|---|---|
| Longhorn prerequisites (`open-iscsi`, `nfs-common`, `iscsid`, `iscsi_tcp`, multipath blacklist) and the iscsid check | yes | yes |
| `/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip` (keeps Longhorn the only default StorageClass) | yes | no |
| Ingress HA fragment `/etc/rancher/k3s/config.yaml.d/60-platform-ingress-ha.yaml` (vip mode: `disable+: [servicelb]`, `tls-san+: [API_VIP]`; removed in external mode) | yes | no |
| kube-vip manifest `/var/lib/rancher/k3s/server/manifests/platform-kube-vip.yaml`, byte-identical to the first server's (vip mode; removed in external mode) | yes | no |

It then writes `/etc/rancher/k3s/config.yaml` (servers repeat the first server's
critical settings: disabled Traefik, Secrets encryption), installs the pinned
k3s release and, unless `--skip-hardening` is given, applies the host security
baseline with the cluster firewall.

k3s merges `config.yaml.d` into `config.yaml`, and list keys ending in `+`
append: the API certificate on every server covers `PLATFORM_API_SANS` and
`API_VIP`, and the disabled components are `traefik` and `servicelb`. k3s
refuses a server whose critical settings (including disabled components)
differ from the cluster's, which is why every server needs the same
`INGRESS_HA_MODE`.

Every server keeps a copy of the kube-vip manifest, so the k3s auto-deploy
source survives losing any one server's disk. k3s applies the manifests
directory of each server, so the copies must be identical: the manifest is
rendered only from the shared settings, never from the host it is written on.
In vip mode a joining server checks the VIP subnet on its own interface (as
`provision` does on the first server) but does not ping the VIPs, which kube-vip
already holds.

**VIP interface.** With `INGRESS_VIP_INTERFACE` unset (recommended), the
manifest has no `vip_interface` and kube-vip binds, on each node, the interface
of the default gateway route, and follows it if that route moves. Servers may
then use different interface names (`eth0` on one, `ens5` on another). When
`INGRESS_VIP_INTERFACE` is set, kube-vip uses that name on every server, so the
interface must exist with that name on all of them: `join --role server` refuses
to continue when it does not exist locally. Either give the interface the same
name on every server (for example with a systemd `.link` file) or leave
`INGRESS_VIP_INTERFACE` unset on the whole cluster.

A joined node only runs k3s: `platformctl provision` is refused there, the
platform is managed from the first server. The ingress HA settings are saved to
the node's `/etc/platform/.env`, so later `harden` runs and a re-run of `join`
use them.

| Flag | Meaning |
|---|---|
| `--role server\|agent` | Join as an etcd server or as a workload-only agent (default `agent`) |
| `--server <url>` | `https://<API_VIP, API DNS name or existing server>:6443` |
| `--token-file <path\|->` | Token file (mode 0600) or `-` for standard input |
| `--nodes <list>` | Cluster node IPs/CIDRs for the firewall (`PLATFORM_CLUSTER_NODES`) |
| `--node-ip <ip>` | Address to advertise (`PLATFORM_NODE_IP`) |
| `--ingress-ha-mode <vip\|external>` | Servers: the cluster's ingress HA mode (`INGRESS_HA_MODE`) |
| `--ingress-vip <ip>` | Servers: the cluster's ingress VIP (`INGRESS_VIP`) |
| `--ingress-vip-interface <name>` | Servers: the cluster's kube-vip interface; empty = default-route autodetect (`INGRESS_VIP_INTERFACE`) |
| `--api-vip <ip>` | The cluster's API VIP (`API_VIP`) |
| `--join-settings <file>` | Servers: settings file from `token create --role server --settings-output`; join refuses when this node's settings differ |
| `--skip-preflight` | Skip the join checks |
| `--skip-hardening` | Leave host security to the operator |

### 4. After joining: reconcile Longhorn replicas

The Longhorn replica count is chosen from the number of Ready nodes when
`platformctl install longhorn` runs; on the first server that is during
`provision`, usually with one node. Once the new nodes are `Ready`, reconcile it
on the first server (`join` prints this reminder):

```bash
sudo platformctl install longhorn
```

Existing volumes keep their saved replica count; see
[Replicas and default storage](#replicas-and-default-storage).

### Status

```bash
sudo platformctl status
```

On a server of an HA cluster `status` lists the nodes with their roles and
readiness, checks etcd health through the API server and warns when the number
of etcd servers cannot tolerate a failure (1, 2 or an even count). On an agent it
reports the `k3s-agent` service.

### Rotating tokens

```bash
sudo platformctl token rotate --output /root/server.token
```

`rotate` runs `k3s token rotate`: k3s generates the new server token itself, so it
never appears on a command line. The new token is saved to
`/etc/platform/k3s/server-token` on this server and written once to `--output`
(or standard output). Then, on **every other server**:

```bash
sudo platformctl token install --role server --token-file /root/server.token
```

which stores the token and restarts k3s. Agents joined with the agent token keep
working: the agent token is separate from the server token. Bootstrap agent tokens
(`--ttl`) expire on their own. etcd snapshots taken before a rotation need the
**old** token to restore; keep it with the snapshots.

## Ingress HA

Ingress HA keeps the portal, the API and project apps reachable when the node
that receives traffic fails. Pick a mode with `INGRESS_HA_MODE`:

| Mode | Use it when |
| --- | --- |
| `vip` (default when `INGRESS_VIP` is set) | All nodes share one L2 subnet and the network accepts gratuitous ARP for an extra address on the NIC (bare metal, most on-premises hypervisors, some VPS providers with private networks). |
| `external` (default when `INGRESS_VIP` is empty) | The provider filters ARP for unknown addresses (common on public clouds and VPS), or you already run an external load balancer or health-checked DNS failover. |

Example:

```bash
sudo PLATFORM_PROFILE=ha PLATFORM_CLUSTER_NODES=10.0.0.0/24 \
  INGRESS_HA_MODE=vip INGRESS_VIP=10.0.0.50 API_VIP=10.0.0.60 platformctl provision
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

platformctl writes two files on the first server before k3s starts, and
`platformctl join --role server` writes the same two files on every joining
server:

- `/etc/rancher/k3s/config.yaml.d/60-platform-ingress-ha.yaml`: `disable+: [servicelb]`
  and, with `API_VIP`, `tls-san+: [<API_VIP>]`.
- `/var/lib/rancher/k3s/server/manifests/platform-kube-vip.yaml`: kube-vip RBAC
  and DaemonSet, applied by the k3s auto-deploy controller. Identical on every
  server; `vip_interface` is set only when `INGRESS_VIP_INTERFACE` is (see
  [VIP interface](#3-join-servers-and-agents)).

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
servers and agents then join through `https://<API_VIP>:6443` instead of one
server's address (see [Join servers and agents](#3-join-servers-and-agents)).

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
set, hardening also accepts TCP 6443 to `API_VIP` from the node subnet, in
addition to the cluster ports it opens to `PLATFORM_CLUSTER_NODES`. Drop-ins in
`/etc/rancher/k3s/config.yaml.d/` such as the ingress HA fragment are accepted;
only drop-ins that set the cluster or service CIDRs are refused.

### TLS certificates

cert-manager's HTTP-01 challenges arrive at whichever node serves the VIP (or
passes the external health check). Every node runs a controller with the same
configuration, so issuance and renewal work regardless of which node answers.

### Switching modes

Set the new values explicitly (including `INGRESS_HA_MODE`, which is persisted
in `/etc/platform/.env` and otherwise keeps its previous value) and run
`platformctl provision` again on the first server:

- `external` to `vip`: the fragment disables ServiceLB, k3s restarts, the
  leftover ServiceLB (`svclb-*`) DaemonSets are deleted and kube-vip takes over
  the Service address.
- `vip` to `external`: the fragment and the kube-vip manifest are removed, k3s
  restarts with ServiceLB enabled, and the `kube-vip-ds` DaemonSet is deleted.

Then re-run `platformctl join` with the same new settings on every other server
(it rewrites the fragment and the kube-vip manifest, and restarts k3s when the
fragment changed), so all servers agree on ServiceLB again. Write a fresh
settings file with `token create --role server --settings-output` and pass it
with `--join-settings` to check each server against the new values.

Clusters provisioned before kube-vip manifests were written on every server
rendered `vip_interface` from the first server's default-route interface when
`INGRESS_VIP_INTERFACE` was unset. Re-running `provision` on the first server
rewrites the manifest without it (kube-vip then autodetects the same interface
on that node); re-run `join --role server` on the other servers so their copies
match.

Anycast or global load balancing, BGP mode, and automating a provider's
floating-IP API are out of scope.

## Replicated storage (Longhorn)

With `platformctl provision --profile ha`, the installer installs the pinned
Longhorn 1.12.1 chart right after k3s, before any workload creates a PVC, and
makes `longhorn` the default StorageClass. The `minimal`, `standard` and `full`
single-node profiles keep k3s local-path storage unchanged.

### Node prerequisites

Provision installs `open-iscsi`, `nfs-common`, `util-linux` and `dmsetup`, enables
`iscsid`, loads `iscsi_tcp`, and persists the module in
`/etc/modules-load.d/longhorn.conf`. If multipathd is installed, it blacklists
only devices with vendor `IET` and product `VIRTUAL-DISK` in
`/etc/multipath/conf.d/longhorn.conf`, then reloads the active service.
`platformctl join` runs the same step, and checks that `iscsid` is active, on
every joining server and agent before k3s starts.

### Replicas and default storage

The installer counts Ready, schedulable nodes:

- Three or more nodes: three replicas.
- Two nodes: two replicas. Storage tolerates one node loss; etcd quorum still
  requires three servers for a highly available control plane.
- Zero or one node: desired count remains three; volumes run degraded with one
  scheduled replica once a node is available. `replicaAutoBalance: best-effort`
  places missing replicas as nodes join.

`LONGHORN_REPLICAS=1`, `2` or `3` overrides the automatic choice. Zero, unset or
invalid values select auto. An override exceeding the available nodes leaves
volumes degraded. After joins, rerun `sudo platformctl install longhorn` on the
first server to reconcile the replica setting. Check existing volumes
individually: changing defaults does not necessarily change their saved replica
counts.

Once CSI and the provisioner are ready, the installer marks local-path non-default
and verifies that Longhorn is the only default. It writes
`/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip` to stop k3s from
restoring its bundled local-path default on restart. **Every k3s server node
needs this file**; `platformctl join --role server` creates it. For a server
added without `platformctl join`:

```bash
sudo mkdir -p /var/lib/rancher/k3s/server/manifests
printf '# HA storage: Longhorn is the default StorageClass.\n' | sudo tee /var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip
```

Other HA components can use `components.HAStorageClass(cfg)` to request an explicit
StorageClass: it returns `longhorn` for HA and an empty string for other profiles
(use the cluster default/local-path). This is the shared contract for the
Postgres, MongoDB, Redis and MinIO HA work.

The manager requests 100m CPU and 128Mi memory per node, limited to one CPU and
1Gi memory. CSI attacher, provisioner, resizer and snapshotter each use two
replicas; the UI uses one. Requests are scheduling reservations, not total
storage memory requirements.

### UI access

The `longhorn-frontend` service is ClusterIP with no Ingress. Use:

```bash
kubectl -n longhorn-system port-forward svc/longhorn-frontend 8000:80
```

Then open `http://localhost:8000`.

### Alerts

The `longhorn-monitoring` step runs after monitoring for HA installs with
monitoring enabled. It applies a ServiceMonitor for manager metrics and the
`longhorn.storage` PrometheusRule group, labeled `release: kube-prometheus`.
Alerts cover degraded volumes (10m, warning), faulted volumes (2m, critical),
nodes not ready (5m, critical), and disk usage above 85% (15m, warning). If
ServiceMonitor CRDs are missing, the step warns and can be rerun later.

### Uninstall caveats

Uninstall deletes Longhorn volumes and their data. Export and test off-site
backups first, stop workloads, and follow the Longhorn uninstall procedure.
Set `deletingConfirmationFlag` to true before `helm uninstall`, which runs the
uninstall Job:

```bash
kubectl -n longhorn-system patch settings.longhorn.io deleting-confirmation-flag \
  --type=merge -p '{"value":"true"}'
helm uninstall longhorn -n longhorn-system
```

To restore local-path as the default, remove the skip file **on every server**
and patch its annotation (restart k3s to restore its bundled manifest if needed):

```bash
sudo rm /var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

Verify that only local-path is default before provisioning new PVCs.

## Upgrades and backups

### Upgrades

k3s is pinned per platformctl release. Upgrade the nodes one at a time, servers
first, waiting for each node to be `Ready` before the next, so etcd keeps quorum.
Never run different platformctl releases on nodes for longer than the rollout.

`platformctl upgrade` reapplies the pinned Longhorn chart using `helm upgrade`;
Longhorn upgrades engines live. Read the Longhorn upgrade notes before upgrading
and advance one minor version at a time. Check volume health and tested backups
first.

Switching an existing install to `ha` does not migrate existing local-path PVCs.
Use `platformctl backup` and `platformctl restore` for supported application
data, or a per-volume copy Job into a new Longhorn PVC. Plan downtime, stop
writers during the final copy, and verify the restored application before
removing old data.

### etcd snapshots

Every server takes etcd snapshots on a schedule (k3s `etcd-snapshot-*`):

| Variable | Default | Meaning |
|---|---|---|
| `ETCD_SNAPSHOT_CRON` | `0 */6 * * *` | Snapshot schedule |
| `ETCD_SNAPSHOT_RETENTION` | `28` | Snapshots kept (per node) |
| `ETCD_S3_ENDPOINT` | | S3/MinIO endpoint (`s3.example.com`); enables S3 upload with `ETCD_S3_BUCKET` |
| `ETCD_S3_BUCKET` | | Bucket |
| `ETCD_S3_REGION` / `ETCD_S3_FOLDER` | | Optional region and folder |
| `ETCD_S3_ACCESS_KEY` / `ETCD_S3_SECRET_KEY` | | Credentials |

Set them before `provision` and `join --role server`. The S3 credentials are
stored in `/etc/rancher/k3s/config.yaml`, which platformctl writes with mode 0600.
Use an **off-site** bucket: the bundled MinIO runs inside the cluster it would
have to restore. Snapshots are listed with `k3s etcd-snapshot ls`; restoring a
cluster follows the k3s procedure (`k3s server --cluster-reset
--cluster-reset-restore-path=<snapshot>` on one server, then rejoin the others).
`platformctl backup --all` also captures an etcd snapshot in its encrypted archive
(see [Backups](backups.md)).

### Longhorn backups to S3

Set `LONGHORN_BACKUP_TARGET=s3://<bucket>@<region>/<path>` and
`LONGHORN_BACKUP_SECRET=<secret-name>`. A target requires an operator-created
Secret in `longhorn-system`. For example, with credentials already supplied in
your shell environment:

```bash
kubectl create namespace longhorn-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n longhorn-system create secret generic longhorn-backup \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_ENDPOINTS="$AWS_ENDPOINTS"
```

Use the provider's S3 endpoint for `AWS_ENDPOINTS`. Configure the installer:

```dotenv
LONGHORN_BACKUP_TARGET=s3://platform-backups@us-east-1/longhorn/
LONGHORN_BACKUP_SECRET=longhorn-backup
```

Only the target and Secret name are saved to the installer .env; Longhorn backup
credentials are never written there. Empty target means no backup target.
Prefer the same off-site bucket used by `platformctl backup`, with a dedicated
`longhorn/` prefix. Bundled in-cluster MinIO is not an off-site backup target.
Configuring a target does not schedule backups: configure and verify recurring
Longhorn backups separately.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `join` pre-flight: `cannot reach <server>:<port>` | The existing nodes' firewall does not admit this node: add its IP to `PLATFORM_CLUSTER_NODES` on every existing node and run `sudo platformctl harden --auto` there. Check cloud security groups too. |
| `join` pre-flight: CA hash mismatch | The token belongs to another cluster, or the server token was rotated: create a new token. |
| `join` pre-flight: k3s version differs | Install the same platformctl release as on the first server. |
| A joining server's k3s fails with a critical configuration mismatch | Its settings differ from the cluster's, most often `INGRESS_HA_MODE` (ServiceLB disabled on some servers only). Export the first server's `INGRESS_HA_MODE`, `INGRESS_VIP` and `API_VIP` and re-run `join`. |
| `join` fails at `longhorn-prereqs` (`iscsid must be active`) | Run `sudo systemctl enable --now iscsid`, make sure `open-iscsi` is installed, and re-run `join`. |
| `x509: certificate is valid for ..., not <API_VIP>` | The server started without the ingress HA fragment: re-run `provision` (first server) or `join` (other servers) with `API_VIP` set. |
| `kubectl get storageclass` shows two defaults | A server lacks `local-storage.yaml.skip`: create it on every server (see [Replicas and default storage](#replicas-and-default-storage)) and patch local-path to non-default. |
| Longhorn volumes stay `Degraded` after joins | Re-run `sudo platformctl install longhorn` on the first server and check each existing volume's replica count in the Longhorn UI. |
| The VIP does not move on failover | The network drops gratuitous ARP for unassigned addresses: use the provider's floating IP or load balancer with `INGRESS_HA_MODE=external`. |
| `harden` refuses a multi-node cluster | Use the ha profile with `PLATFORM_CLUSTER_NODES`, or manage the firewall yourself (`--skip-hardening`). |

### Verifying failover

```bash
kubectl get nodes                                         # 3 servers (control-plane,etcd) and the agents Ready
kubectl get storageclass                                  # only longhorn is default
kubectl -n kube-system get lease | grep -i -e kubevip -e plndr
kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-vip -o wide
ip -4 addr show dev <iface>                               # on the holder: INGRESS_VIP/32 is listed
kubectl -n ingress-nginx get svc ingress-nginx-controller # EXTERNAL-IP = INGRESS_VIP
kubectl -n ingress-nginx get ds                           # one controller per node

# From a client outside the cluster, keep requesting the portal...
while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" --max-time 2 https://<domain>/; sleep 0.5; done
# ...and power off the node holding the VIP. Expect at most a few seconds of errors.
```

1. Power off one server. Within a minute `kubectl get nodes` (from another server)
   still answers and shows the node `NotReady`; the portal and API stay available.
2. Workloads on the lost node are rescheduled after the node eviction timeout;
   their Longhorn volumes reattach on a healthy node with the data intact.
3. Power the server back on; it rejoins without intervention and Longhorn
   rebuilds its replicas until volume health returns to healthy.
4. Verify a Longhorn backup and restore from the off-site S3 target.

## Related

- [Host hardening](../host-hardening.md)
- [Backups](backups.md)
- [Upgrades](upgrades.md)
- [platformctl CLI](../getting-started/platformctl.md)
