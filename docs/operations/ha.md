# High availability: multi-node k3s with embedded etcd

The `ha` install profile runs the platform on several nodes. k3s keeps the
cluster state in **embedded etcd** replicated across the server nodes, so the
Kubernetes API keeps working when one server is lost. Extra **agent** nodes add
workload capacity.

This page covers the cluster layer: forming the cluster, joining nodes, tokens,
the firewall and etcd snapshots. Replicated storage, the database operators and
the ingress virtual IP are separate parts of the HA profile.

## Topology

| Servers | Tolerates losing | Notes |
|---|---|---|
| 1 | 0 | Not HA. `platformctl status` warns until 3 servers have joined |
| 2 | 0 | **Not HA**: losing either server loses etcd quorum |
| 3 | 1 | Recommended minimum |
| 4 | 1 | An even count adds no fault tolerance; use 5 instead |
| 5 | 2 | |

etcd needs a majority of servers (`n/2 + 1`) to accept writes. Use an odd number
of servers (3 or 5). Agents do not run etcd and do not count towards quorum.

Each node needs Ubuntu 22.04+ with the same requirements as a single-node install,
synchronised clocks (chrony is installed by host hardening) and a private network
between the nodes is strongly recommended.

## Ports between nodes

| Port | Protocol | Purpose | Needed on |
|---|---|---|---|
| 6443 | TCP | Kubernetes API and k3s supervisor (node join) | servers |
| 2379, 2380 | TCP | etcd client and peer traffic | servers |
| 10250 | TCP | kubelet (logs, exec, metrics) | all nodes |
| 8472 | UDP | flannel VXLAN pod network | all nodes |

With host hardening enabled (the default), platformctl opens these ports **only
to the addresses in `PLATFORM_CLUSTER_NODES`** on every node. Everything else
stays as on a single node: 22/80/443 are public, everything else is dropped.
Cloud security groups must allow the same ports between the nodes.

## 1. First server

```bash
export PLATFORM_CLUSTER_NODES=10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21   # every node (IPs or a CIDR such as 10.0.0.0/24)
export PLATFORM_API_SANS=k8s.example.com,10.0.0.100                       # optional: API VIP / DNS name
export PLATFORM_NODE_IP=10.0.0.11                                          # optional: private address to advertise
sudo -E platformctl provision --profile ha
```

The first server starts k3s with `cluster-init` (embedded etcd), Secrets
encryption and the TLS SANs above, then installs the platform as usual. The
settings are saved in `/etc/platform/.env`, so re-running `provision` keeps them.

platformctl generates the cluster tokens before k3s starts and keeps them in
`/etc/platform/k3s/` (mode 0600): `server-token` joins servers, `agent-token`
joins agents. An existing single-node install switched to `--profile ha` keeps its
current k3s token and is converted from SQLite to etcd on the k3s restart; take a
backup (`platformctl backup --all`) first.

`PLATFORM_CLUSTER_NODES` is required while host hardening is enabled: without it the
firewall would block the other nodes. List all planned nodes up front, or use the
private subnet CIDR. To add a node later, add its IP on every existing node and run
`sudo platformctl harden --auto` there.

## 2. Create a join token

On the first server:

```bash
# Server token (joins servers). Written to a 0600 file, never printed to logs.
sudo platformctl token create --role server --output /root/server.token

# Agent token: an expiring bootstrap token (recommended) ...
sudo platformctl token create --role agent --ttl 2h --output /root/agent.token
# ... or the static agent token
sudo platformctl token create --role agent --output /root/agent.token
```

Without `--output` the token is printed once to standard output. Tokens use the
k3s secure format (`K10<ca-hash>::...`): the joining node checks the cluster's CA
against the hash before it sends any credential. Copy the file to the new node
over SSH (`scp`) and delete it afterwards.

## 3. Join servers and agents

On each new node (fresh Ubuntu, `platformctl` installed with `install.sh`):

```bash
# second and third server
sudo platformctl join --role server --server https://10.0.0.11:6443 \
  --token-file /root/server.token --nodes 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21

# agent
sudo platformctl join --role agent --server https://10.0.0.11:6443 \
  --token-file /root/agent.token --nodes 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21
```

`--token-file -` reads the token from standard input
(`ssh first-server sudo platformctl token create --role agent --ttl 1h | sudo platformctl join ... --token-file -`).
The token is never accepted on the command line, where other users could read it.

Before changing anything, `join` checks:

- the ports above are reachable on the first server (6443/10250, plus 2379/2380 for servers);
- the token belongs to that cluster (CA hash);
- the clock is synchronised and within 5 s of the server;
- the cluster runs the k3s version this platformctl installs (use the same
  platformctl release on every node);
- the local k3s ports are free.

Use `--server https://<API VIP or DNS name>:6443` once a virtual IP or load
balancer is in front of the servers, so joins do not depend on the first server.

Then it writes `/etc/rancher/k3s/config.yaml` (servers repeat the first server's
critical settings: disabled Traefik, Secrets encryption; k3s refuses servers whose
critical settings differ), installs the pinned k3s release and, unless
`--skip-hardening` is given, applies the host security baseline with the cluster
firewall. A joined node only runs k3s: `platformctl provision` is refused there,
the platform is managed from the first server.

| Flag | Meaning |
|---|---|
| `--role server\|agent` | Join as an etcd server or as a workload-only agent (default `agent`) |
| `--server <url>` | `https://<existing server or API VIP>:6443` |
| `--token-file <path\|->` | Token file (mode 0600) or `-` for standard input |
| `--nodes <list>` | Cluster node IPs/CIDRs for the firewall (`PLATFORM_CLUSTER_NODES`) |
| `--node-ip <ip>` | Address to advertise (`PLATFORM_NODE_IP`) |
| `--skip-preflight` | Skip the join checks |
| `--skip-hardening` | Leave host security to the operator |

## Status

```bash
sudo platformctl status
```

On a server of an HA cluster `status` lists the nodes with their roles and
readiness, checks etcd health through the API server and warns when the number
of etcd servers cannot tolerate a failure (1, 2 or an even count). On an agent it
reports the `k3s-agent` service.

## Rotating tokens

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

## etcd snapshots

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

## Upgrades

k3s is pinned per platformctl release. Upgrade the nodes one at a time, servers
first, waiting for each node to be `Ready` before the next, so etcd keeps quorum.
Never run different platformctl releases on nodes for longer than the rollout.

## Verifying failover

1. `kubectl get nodes` shows 3 servers (`control-plane,etcd`) and the agents `Ready`.
2. Power off one server. Within a minute `kubectl get nodes` (from another server)
   still answers and shows the node `NotReady`; the portal and API stay available.
3. Workloads on the lost node are rescheduled after the node eviction timeout.
4. Power the server back on; it rejoins without intervention.

## Related

- [Host hardening](../host-hardening.md)
- [Backups](backups.md)
- [Upgrades](upgrades.md)
- [platformctl CLI](../getting-started/platformctl.md)
