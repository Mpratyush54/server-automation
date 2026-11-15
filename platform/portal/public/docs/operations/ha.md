# Run Cairn on several servers

This page helps you run Cairn on three or more servers, so the portal, the API and your apps keep working when one server fails. You set it up with `platformctl` on each server. Afterwards, **Infrastructure** in the portal sidebar (DevOps role) lists the servers and shows the command to add another one.

Single-server installs are not affected by anything on this page.

## Before you start

- **Three servers**, or five. An odd number is needed: the cluster keeps working only while more than half of the servers are up. Two servers are not enough, because losing either one stops the cluster.
- Ubuntu 22.04 or newer on each server, with the same requirements as a [single-server install](../getting-started/installation.md).
- A private network between the servers.
- At least 4 vCPUs and 100 GB of disk per server for production.
- The same `platformctl` release on every server.
- A way for visitors to reach whichever server is up. Pick one:

| Option | Use it when | Setting |
|---|---|---|
| **Floating address** | All servers are on one local subnet and the network lets a server claim an extra IP address (bare metal, most on-premises hypervisors). You need one free IP address for web traffic, and ideally a second one for the cluster itself. | `INGRESS_HA_MODE=vip` |
| **External load balancer or DNS failover** | You are on a public cloud or VPS that does not allow that, or you already have a load balancer. | `INGRESS_HA_MODE=external` |

## Set up three servers

This example uses servers `10.0.0.11`, `10.0.0.12` and `10.0.0.13`, the floating web address `10.0.0.50` and the floating cluster address `10.0.0.60`.

1. On the first server, list every server and install with the `ha` profile:

   ```bash
   export PLATFORM_CLUSTER_NODES=10.0.0.11,10.0.0.12,10.0.0.13
   export INGRESS_HA_MODE=vip INGRESS_VIP=10.0.0.50 API_VIP=10.0.0.60
   sudo -E platformctl provision --profile ha
   ```

   `PLATFORM_CLUSTER_NODES` tells the firewall which machines may talk to each other. You can also give the private subnet, such as `10.0.0.0/24`.

   `provision` also asks whether database writes wait for a copy on a second server (`sync`, the default: no confirmed write is lost) or not (`async`: writes do not wait, but the last confirmed writes can be lost when a server dies; failover takes about 1 to 2 minutes in both modes). See [Synchronous or asynchronous database replication](postgres-replication.md). Add `--postgres-replication sync|async` to skip the question.

2. Still on the first server, create a join token and a join settings file:

   ```bash
   sudo platformctl token create --role server --output /root/server.token \
     --settings-output /root/join-settings
   ```

   The token is a secret. The settings file is not, but keep the two together.

3. Copy both files to the second server (for example with `scp`). [Install `platformctl`](../getting-started/installation.md) there, then join:

   ```bash
   sudo platformctl join --role server --server https://10.0.0.60:6443 \
     --token-file /root/server.token --join-settings /root/join-settings \
     --ingress-ha-mode vip --ingress-vip 10.0.0.50 --api-vip 10.0.0.60 \
     --nodes 10.0.0.11,10.0.0.12,10.0.0.13
   ```

4. Repeat step 3 on the third server. Delete the token files when you are done.

5. Back on the first server, spread the stored data over the new servers:

   ```bash
   sudo platformctl install longhorn
   ```

6. Check the cluster:

   ```bash
   sudo platformctl status
   ```

   It lists the servers and warns while fewer than three can vote.

7. Point your domain's DNS record (and `*.<domain>` if you use it) at the floating web address, `10.0.0.50` here. With an external load balancer, point it at the load balancer instead and see [Use an external load balancer](#use-an-external-load-balancer).

> [!NOTE]
> Run `provision` only on the first server. The other servers are managed from there; `provision` refuses to run on a server that joined.

## Add more capacity

To add a machine that only runs apps (an *agent*: it does not vote and does not hold the floating address), create a short-lived token on one of the servers (not on an agent):

```bash
sudo platformctl token create --role agent --ttl 2h --output /root/agent.token
```

Copy it to the new machine and join:

```bash
sudo platformctl join --role agent --server https://10.0.0.60:6443 \
  --token-file /root/agent.token --nodes 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.21
```

When you add a machine that was not in `PLATFORM_CLUSTER_NODES`, add its IP on every existing server and run `sudo platformctl harden --auto` there first, or the firewall blocks it. Then run `sudo platformctl install longhorn` on the first server again.

## Join without internet access

A node that can reach only the cluster network can join from the offline bundle of the same platformctl release, for its architecture: `platform-bundle-<version>-<amd64|arm64>.tar.zst`. The release publishes it in parts; join them with `cat platform-bundle-<version>-amd64.tar.zst.part* > platform-bundle-<version>-amd64.tar.zst` and keep the `.sha256` file next to it. The bundle holds the pinned k3s binary and installer, the k3s and third-party images (kube-vip included), this release's Cairn images, and the Ubuntu 22.04 and 24.04 packages the node needs (Longhorn prerequisites and host hardening packages, with their dependencies). Bundles from releases without offline join support lack k3s and the packages; join refuses them.

Copy the bundle, its `.sha256` file, the token file (mode `0600`) and, for servers, the join settings file to the new node. On a server:

```bash
sudo platformctl join --role server --server https://10.0.0.60:6443 \
  --token-file /root/server.token --join-settings /root/join-settings \
  --ingress-ha-mode vip --ingress-vip 10.0.0.50 --api-vip 10.0.0.60 \
  --nodes 10.0.0.0/24 --bundle /root/platform-bundle-<version>-amd64.tar.zst
```

On an agent, use `--role agent` with the agent token and leave out the join settings and ingress flags.

With `--bundle`, join:

- checks the bundle against its `.sha256` file and every file against the bundle's `SHA256SUMS` (required for k3s and the packages), and stops on a mismatch
- places every image in `/var/lib/rancher/k3s/agent/images` before k3s starts, so k3s imports them into containerd at startup
- installs missing packages from the bundle with apt, using only the bundle as a package source; it stops when the OS is not Ubuntu 22.04 or 24.04, when a dependency is not in the bundle, or when the install would remove a package (chrony replacing systemd-timesyncd is the exception)
- installs k3s from the bundle, with no download fallback
- once the kubelet runs, adds the digest names of images that charts pin by digest (the ingress-nginx controller and its admission webhook job), so their pods start on this node without a registry

The join checks still need the cluster: its API, etcd (servers) and kubelet ports, the token's CA and the clock. The node needs time synchronisation it can reach, such as an NTP server on the private network. Images that are not in the bundle, such as your applications, need a registry the node can reach.

`--bundle auto` downloads the release's bundle, so it needs internet access. Without `--bundle`, join downloads the platform stack chosen by `PLATFORM_STACK` (default `stable`) before k3s starts; `PLATFORM_STACK=off` skips it.

The first server can be provisioned from the same bundle without internet access too: see [Offline bundle](../getting-started/platformctl.md#offline-bundle). The packages and the Helm binary ship only in the release bundle, not in the platform stack.

Release CI builds the bundles with `scripts/build-bundle.sh <version> <amd64|arm64>`, which downloads the packages inside Ubuntu containers of each release and architecture, and the Helm release from `get.helm.sh`, checked against its published SHA-256.

After the join, run `sudo platformctl install longhorn` on the first server, as above.

## Use an external load balancer

With `INGRESS_HA_MODE=external`, every server answers on ports 80 and 443. Put one of these in front:

- **DNS failover with health checks.** For example, a Cloudflare load-balancing pool with every server's public address, or one Route 53 health check per server with failover records and a 60 second TTL. Check `GET /healthz` on port 80; every server returns 200.
- **A TCP load balancer** (cloud load balancer, HAProxy, a keepalived pair) that forwards 80 and 443 to every server with the same health check.

A load balancer that rewrites connections hides the visitor's address. All requests then seem to come from the load balancer, and per-address limits apply to it as a whole. If visitor addresses matter, use DNS failover or a load balancer that keeps the source address.

## Test a failover

1. From a computer outside the cluster, keep requesting the portal:

   ```bash
   while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" --max-time 2 https://<domain>/; sleep 0.5; done
   ```

2. Power off one server. Expect a few seconds of errors at most. The portal and API stay available.
3. On another server, `kubectl get nodes` shows the stopped server as `NotReady` within a minute. Its apps start again on the other servers after about a minute and a half.
4. Power the server back on. It rejoins by itself.

## Back up a cluster

- `sudo platformctl backup --all` works as on one server and also saves the cluster state. See [Backups](backups.md).
- The platform database, etcd snapshots and Longhorn volumes are backed up to the off-site backup target you chose during provisioning. See [Choose where backups go](backups.md#choose-where-backups-go).
- You can restore the platform database to any moment since the oldest kept backup:

  ```bash
  sudo platformctl restore --pitr 2026-11-12T10:00:00Z --confirm
  ```

  This stops the API and replaces the database, so stop your apps' writes first. Details: [Point-in-time recovery](#point-in-time-recovery-pitr).

## Rotate the join token

On one server:

```bash
sudo platformctl token rotate --output /root/server.token
```

Then on every other server:

```bash
sudo platformctl token install --role server --token-file /root/server.token
```

Agents keep working: they use a separate token. Keep the old token with older cluster snapshots, because restoring them needs it.

## Upgrade

Upgrade one server at a time, servers before agents. Wait until each one is `Ready` in `kubectl get nodes` before the next. Do not leave servers on different `platformctl` releases for longer than the rollout. See [Upgrade](upgrades.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `join` says `cannot reach <server>:<port>` | The existing servers' firewall does not know the new machine. Add its IP to `PLATFORM_CLUSTER_NODES` on every existing server and run `sudo platformctl harden --auto` there. Check cloud security groups too. |
| `join` reports a CA hash mismatch | The token is from another cluster, or it was rotated. Create a new token. |
| `join` says the cluster version differs | Install the same `platformctl` release as on the first server. |
| `join` says this server's ingress HA settings differ from the cluster's | Use the values from the join settings file for `--ingress-ha-mode`, `--ingress-vip`, `--ingress-vip-interface` and `--api-vip`. |
| `join` stops at `longhorn-prereqs` (`iscsid must be active`) | Run `sudo systemctl enable --now iscsid`, check that `open-iscsi` is installed, and run `join` again. |
| A joining server fails with a "critical configuration value mismatch" | Its settings differ from the cluster's, most often `INGRESS_HA_MODE`. Export the first server's `INGRESS_HA_MODE`, `INGRESS_VIP` and `API_VIP` and run `join` again. |
| `x509: certificate is valid for ..., not <API_VIP>` | The server started without the floating cluster address. Run `provision` (first server) or `join` (other servers) again with `API_VIP` set. |
| The floating address does not move when a server stops | The network ignores address announcements from servers. Use the provider's floating IP or load balancer with `INGRESS_HA_MODE=external`. |
| `harden` refuses a multi-node cluster | Use the `ha` profile with `PLATFORM_CLUSTER_NODES`, or manage the firewall yourself with `--skip-hardening`. |
| Database standbys stay `Pending` | They need three servers with free CPU, memory and disk. Join the other servers and check capacity. The first copy accepts writes on its own meanwhile. |
| Stored volumes stay `Degraded` after joins | Run `sudo platformctl install longhorn` on the first server and check each volume's replica count (see [Replicated storage](#replicated-storage-longhorn)). |
| `kubectl get storageclass` shows two defaults | A server lacks the skip file. See [Replicas and default storage](#replicas-and-default-storage). |
| A joined server does not start after a reboot: `cred/passwd newer than datastore` | See [Server stops after a reboot](#server-stops-after-a-reboot). |
| Database backups fail: archive is not empty | A new database cluster cannot reuse a used backup location. Set a new bucket or prefix in `POSTGRES_BACKUP_DESTINATION` and keep the old backups. |
| Applying the database cluster fails: webhook not ready | The installer retries for about two minutes. Check `kubectl -n cnpg-system rollout status deploy/cnpg-cloudnative-pg`, then run it again. |
| `platformctl status` shows `Longhorn volumes: ... FAULTED` | A volume lost its only copy, often a one-copy `longhorn-single` volume after a server was powered off. Longhorn does not repair it on its own. See [Recover a faulted volume](#recover-a-faulted-volume). |
| `platformctl status` shows `MongoDB replica set rs0: NO PRIMARY` | Fewer than two of the three members are running, so the set accepts no writes. Check `kubectl -n databases get pods -l app.kubernetes.io/name=mongodb -o wide`; a member stuck because its volume is faulted needs [Recover a faulted volume](#recover-a-faulted-volume). |
| `platformctl status` warns that the CloudNativePG operator replicas are on one node | Both replicas started on the first server before the others joined. Run `sudo platformctl install longhorn` (it restarts the operator once more servers are Ready) or `kubectl -n cnpg-system rollout restart deploy/cnpg-cloudnative-pg`. Only the operator restarts; the database keeps running. |

### Recover a faulted volume

A Longhorn volume is *faulted* when none of its copies can be used. MongoDB and Redis members use the `longhorn-single` StorageClass, which keeps one copy on the member's server, because the replica set and Sentinel already keep a full copy on each server. If that server is powered off hard, its volume can come back faulted. The member's pod then cannot start, and Longhorn does not repair the volume by itself.

`platformctl status` names each faulted volume with its PVC and namespace:

```text
  ✗ Longhorn volumes: 11 healthy, 1 FAULTED
    ✗ Longhorn volume pvc-3f2c... is faulted (PVC datadir-mongodb-0 in namespace databases)
```

For a MongoDB or Redis member, the other two members still hold all the data. The safe recovery is to give the member an empty volume and let it copy the data from the others. `platformctl` does not do this for you, because it deletes the member's old volume.

1. Make sure the other members are healthy. For MongoDB, `platformctl status` must show a primary and 2 of 3 members ready. For Redis, it must show a master. If they are not, stop here: the faulted volume may hold the only copy.
2. Delete the PVC and the pod of that member. Use the names from `platformctl status`; for `datadir-mongodb-0`:

   ```bash
   kubectl -n databases delete pvc datadir-mongodb-0 --wait=false
   kubectl -n databases delete pod mongodb-0
   ```

   The StatefulSet creates a new pod and a new, empty volume.
3. Watch the member come back and copy the data. MongoDB lists the member as `STARTUP2` while it copies, then as `SECONDARY`:

   ```bash
   kubectl -n databases get pods -l app.kubernetes.io/name=mongodb -w
   sudo platformctl status
   ```

4. The old Longhorn volume is removed with its PVC. If it stays in the Longhorn UI as detached and faulted, delete it there.

Do not do this for a volume that is not a replica set or Sentinel member, such as a MinIO drive or an app volume: there the volume may hold data that exists nowhere else. Restore those from a backup instead (see [Back up a cluster](#back-up-a-cluster)).

## How it works

The `ha` profile (`PLATFORM_PROFILE=ha`) installs everything the `full` profile does, plus five layers:

1. **Cluster.** k3s keeps the cluster state in embedded etcd, replicated across the server nodes, so the Kubernetes API keeps working when one server is lost. Agent nodes add workload capacity only.
2. **Ingress HA.** The portal, the API and project apps stay reachable when the node that receives traffic fails (kube-vip floating IP, or an external load balancer or DNS failover).
3. **Replicated storage.** Longhorn replicates PersistentVolumes across nodes and is the default StorageClass.
4. **Datastores.** MongoDB runs as a three-member replica set, Redis runs with Sentinel on three nodes, and MinIO runs in distributed mode on four drives.
5. **PostgreSQL HA.** CloudNativePG runs a primary and two standbys on separate nodes, with continuous WAL archiving and daily base backups.

The platform API and the portal run two replicas each on `ha`. A topology spread constraint (`maxSkew: 1`, `whenUnsatisfiable: DoNotSchedule`, per hostname) never puts two replicas on one node while another node can take them, but still schedules both on a cluster that has only one node so far. ingress-nginx runs as a DaemonSet (one controller per node).

Single-node profiles (`minimal`, `standard`, `full`) keep a single-node k3s, k3s local-path storage and a single ingress-nginx Deployment behind k3s ServiceLB.

### Quorum

| Servers | Tolerates losing | Notes |
|---|---|---|
| 1 | 0 | Not HA. `platformctl status` warns until 3 servers have joined |
| 2 | 0 | Not HA: losing either server loses etcd quorum |
| 3 | 1 | Recommended minimum |
| 4 | 1 | An even count adds no fault tolerance; use 5 |
| 5 | 2 | |

etcd needs a majority of servers (`n/2 + 1`) to accept writes. Agents do not run etcd and do not count towards quorum.

### Sizing

- The `ha` profile reserves (Kubernetes CPU requests) about 4.8 cores across the cluster. Three 2-vCPU nodes run it but leave little room for rolling updates. Check headroom with `kubectl describe nodes | grep -A3 "Allocated resources"`.
- Plan roughly 500 MB or more RAM per node for the storage services.
- Longhorn reserves 30% of each disk and, with the installer's 200% over-provisioning, schedules volumes up to about 1.4 times the disk size. Volumes are thin-provisioned: real usage is what is written.
- Clocks must be synchronised. Host hardening installs chrony.

### Ports between nodes

| Port | Protocol | Purpose | Needed on |
|---|---|---|---|
| 6443 | TCP | Kubernetes API and k3s supervisor (node join) | servers |
| 2379, 2380 | TCP | etcd client and peer traffic | servers |
| 9100 | TCP | node-exporter host metrics (Prometheus scrapes every node) | all nodes |
| 10250 | TCP | kubelet (logs, exec, metrics) | all nodes |
| 8472 | UDP | flannel VXLAN pod network | all nodes |

With host hardening on (the default), platformctl opens these ports only to the addresses in `PLATFORM_CLUSTER_NODES`. Everything else stays as on a single node: 22, 80 and 443 are public, the rest is dropped. With `API_VIP` set, hardening also accepts TCP 6443 to `API_VIP` from the node subnet. Longhorn needs no extra ports: its traffic stays on the pod network and iSCSI is node-local. Cloud security groups must allow the same ports. See [Host hardening](../guides/host-hardening.md).

The firewall already accepts TCP 80/443 to any local address, including a VIP, and forwards connections whose original destination port is 80/443. It does not filter ARP. Drop-ins in `/etc/rancher/k3s/config.yaml.d/` are accepted, except drop-ins that set the cluster or service CIDRs.

### Settings

| Variable | Layer | Meaning |
|---|---|---|
| `PLATFORM_PROFILE=ha` | all | Selects the ha profile |
| `PLATFORM_CLUSTER_NODES` | cluster | Every node's IP, or the private subnet CIDR (firewall peers). Required while host hardening is on |
| `PLATFORM_API_SANS` | cluster | Extra DNS names or IPs for the Kubernetes API certificate |
| `PLATFORM_NODE_IP` | cluster | Private address k3s advertises for this node |
| `ETCD_*` | cluster | etcd snapshot schedule and S3 target ([below](#etcd-snapshots)) |
| `INGRESS_HA_MODE` | ingress | `vip` (default when `INGRESS_VIP` is set) or `external` (default when it is empty) |
| `INGRESS_VIP` | ingress | Floating IPv4 address for the ingress LoadBalancer Service (required in `vip` mode) |
| `INGRESS_VIP_INTERFACE` | ingress | NIC that carries the VIP; must have this name on every server (unset: kube-vip uses each node's default-route interface) |
| `API_VIP` | ingress | Optional floating IPv4 address for the Kubernetes API (`vip` mode only) |
| `POSTGRES_HA_STORAGE_CLASS` | PostgreSQL | Instance StorageClass (default `local-path`) |
| `POSTGRES_BACKUP_DESTINATION` | PostgreSQL | External `s3://bucket/prefix/`; empty selects bundled MinIO |
| `POSTGRES_BACKUP_ENDPOINT` | PostgreSQL | Optional HTTP(S) S3 endpoint |
| `POSTGRES_BACKUP_SECRET` | PostgreSQL | External credentials Secret in `databases` (required with a destination) |
| `POSTGRES_BACKUP_RETENTION` | PostgreSQL | Retention (default `14d`; positive `d`, `w` or `m`) |
| `POSTGRES_REPLICATION` | PostgreSQL | `sync` (default) or `async`; see [database replication](postgres-replication.md). Flag: `provision --postgres-replication` |
| `LONGHORN_REPLICAS` | storage | `1`, `2` or `3`; unset means automatic |
| `LONGHORN_BACKUP_TARGET` / `LONGHORN_BACKUP_SECRET` | storage | Longhorn S3 backup target and credentials Secret name |

They are saved to `/etc/platform/.env`, so re-running `provision` keeps them.

### First server

`provision --profile ha` on the first server, in order:

1. writes the ingress HA k3s config fragment and the kube-vip manifest (`ingress-ha` step, before k3s starts);
2. starts k3s with `cluster-init` (embedded etcd), Secrets encryption and the TLS SANs (`PLATFORM_API_SANS`, plus `API_VIP`);
3. installs Longhorn and makes it the default StorageClass before any workload creates a PersistentVolumeClaim;
4. installs the platform as usual.

platformctl generates the cluster tokens before k3s starts and keeps them in `/etc/platform/k3s/` (mode 0600): `server-token` joins servers, `agent-token` joins agents. An existing single-node install switched to `--profile ha` keeps its k3s token and is converted from SQLite to etcd on the k3s restart. Take a backup (`platformctl backup --all`) first.

### Tokens and the join settings file

A server token file holds two lines: the server token and the cluster's agent token. Every k3s server must use the same agent token. `join --role server` writes it to `/etc/platform/k3s/agent-token` and sets `agent-token-file` before k3s starts.

`token create --role agent` without `--ttl` prints the static agent token. With `--ttl` (10m to 720h) it creates an expiring bootstrap token. Without `--output`, the token is printed once to standard output. Tokens use the k3s secure format (`K10<ca-hash>::...`): the joining node checks the cluster's CA against the hash before it sends any credential. The token is never accepted on the command line and is never printed to logs.

The join settings file holds the cluster's ingress HA settings and, when backups go to an off-site target, the name of the Secret that holds the etcd snapshot target:

```
# platformctl join settings v1
# Cluster ingress HA and etcd snapshot settings for `platformctl join --role server --join-settings <file>`. No secrets.
INGRESS_HA_MODE=vip
INGRESS_VIP=10.0.0.50
INGRESS_VIP_INTERFACE=
API_VIP=10.0.0.60
ETCD_S3_CONFIG_SECRET=platform-etcd-s3
```

`ETCD_S3_CONFIG_SECRET` is only a name. The endpoint and keys stay in that Secret inside the cluster. A joining server writes it into its k3s config before k3s starts there, so it uploads etcd snapshots too. It is not compared like the ingress settings, and the line is left out when backups are local only.

Without `--settings-output`, `token create --role server` prints the same block on standard error (standard output carries only the token). Agents need no settings file. A joining node has no credentials for the cluster API before k3s runs, so this file is how it learns the cluster's settings.

With `--join-settings`, a joining server compares its own settings with the file before it changes anything, and stops when they differ. In `vip` mode all four values must match; in `external` mode only the mode is compared. Without `--join-settings`, `join` warns and uses its own settings unchecked; a mismatched mode then shows up only as k3s refusing to start. `--join-settings` is ignored for agents.

### Joining

`--server` takes `https://<API_VIP>:6443` (recommended once `API_VIP` is set: the join and later reconnects do not depend on the first server), a DNS name from `PLATFORM_API_SANS`, or `https://<first server IP>:6443`. The ingress flags default to `INGRESS_HA_MODE`, `INGRESS_VIP`, `INGRESS_VIP_INTERFACE` and `API_VIP` from the environment, so `export ...; sudo -E platformctl join ...` works too. A `--ingress-vip` given without a mode selects `vip` mode.

`--token-file -` reads the token from standard input:

```bash
ssh first-server sudo platformctl token create --role agent --ttl 1h | sudo platformctl --auto join ... --token-file -
```

Without `--auto`, the firewall step waits for you to type `confirm`. When standard input is not a terminal, `join` stops before arming the firewall and asks for `--auto`, where automatic health checks confirm the rules.

Before changing anything, `join` checks:

- the ports are reachable on the server (6443 and 10250, plus 2379/2380 for servers; through the API VIP the etcd ports are not dialled, because etcd listens on node addresses only, and `join` warns instead);
- the token belongs to that cluster (CA hash);
- the clock is synchronised and within 5 s of the server;
- the cluster runs the k3s version this platformctl installs;
- the local k3s ports are free.

Then, before k3s starts, it prepares the node:

| Step | Servers | Agents |
|---|---|---|
| Longhorn prerequisites (`open-iscsi`, `nfs-common`, `iscsid`, `iscsi_tcp`, multipath blacklist) and the iscsid check | yes | yes |
| `/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip` (keeps Longhorn the only default StorageClass) | yes | no |
| Ingress HA fragment `/etc/rancher/k3s/config.yaml.d/60-platform-ingress-ha.yaml` (vip mode: `disable+: [servicelb]`, `tls-san+: [API_VIP]`; removed in external mode) | yes | no |
| kube-vip manifest `/var/lib/rancher/k3s/server/manifests/platform-kube-vip.yaml`, byte-identical to the first server's (vip mode; removed in external mode) | yes | no |

It then writes `/etc/rancher/k3s/config.yaml` (servers repeat the first server's critical settings: disabled Traefik, Secrets encryption), installs the pinned k3s release and, unless `--skip-hardening` is given, applies the host security baseline with the cluster firewall. The ingress HA settings are saved to the node's `/etc/platform/.env`, so later `harden` runs and a re-run of `join` use them.

k3s merges `config.yaml.d` into `config.yaml`, and list keys ending in `+` append. k3s refuses a server whose critical settings (including disabled components) differ from the cluster's, which is why every server needs the same `INGRESS_HA_MODE`.

HA servers also set:

- `kube-controller-manager-arg: node-monitor-grace-period=20s` (Kubernetes default 40 s). A node that stops renewing its lease is marked NotReady after 20 s, so Service endpoints and the PostgreSQL failover react sooner. The cost: a node whose kubelet misses two lease renewals is briefly marked NotReady.
- `kube-apiserver-arg: default-not-ready-toleration-seconds=60` and `default-unreachable-toleration-seconds=60` (default 300). Pods on a node that stays down are evicted after about 80 s in total. Pods that declare their own tolerations keep them.
- `etcd-arg: heartbeat-interval=200` and `election-timeout=2000` (k3s default 500 ms and 5 s). When the server that leads etcd fails, the others elect a new leader in about 3 s instead of 5 to 6 s, and the Kubernetes API answers again sooner. Keep the servers on a low-latency network (round trips well under 100 ms).
- One CoreDNS replica per server, up to 3. Each `join --role server` raises the count once the new server is Ready; k3s alone runs one, and in-cluster name lookups failed until it was rescheduled, 5 minutes after its server lost power on the failover test.

| `join` flag | Meaning |
|---|---|
| `--role server\|agent` | Join as an etcd server or as a workload-only agent (default `agent`) |
| `--server <url>` | `https://<API_VIP, API DNS name or existing server>:6443` |
| `--token-file <path\|->` | Token file (mode 0600) or `-` for standard input |
| `--nodes <list>` | Cluster node IPs/CIDRs for the firewall (default `PLATFORM_CLUSTER_NODES`) |
| `--node-ip <ip>` | Address to advertise (default `PLATFORM_NODE_IP`) |
| `--ingress-ha-mode <vip\|external>` | Servers: the cluster's ingress HA mode |
| `--ingress-vip <ip>` | Servers: the cluster's ingress VIP |
| `--ingress-vip-interface <name>` | Servers: the cluster's kube-vip interface; empty means default-route autodetect |
| `--api-vip <ip>` | The cluster's API VIP |
| `--join-settings <file>` | Servers: settings file from `token create --role server --settings-output` |
| `--skip-preflight` | Skip the join checks |
| `--skip-hardening` | Leave host security to the operator |

### Status

On a server, `platformctl status` lists the nodes with their roles and readiness, checks etcd health through the API server and warns when the number of etcd servers cannot tolerate a failure (1, 2 or an even count). On an agent it reports the `k3s-agent` service. On the first server it also reports the datastores and PostgreSQL (see below).

### Token rotation

`token rotate` runs `k3s token rotate`: k3s generates the new server token itself. The new token is saved to `/etc/platform/k3s/server-token` and written once to `--output` (or standard output). `token install` stores the token and restarts k3s. Bootstrap agent tokens (`--ttl`) expire on their own. etcd snapshots taken before a rotation need the old token to restore.

### Server stops after a reboot

A server joined by an older platformctl release that did not pass the agent token has an agent credential that differs from the cluster's. k3s then exits after a reboot with `cred/passwd newer than datastore`. With the other servers healthy, on the affected server only:

1. Copy `/var/lib/rancher/k3s/server/agent-token` from a healthy server to `/etc/platform/k3s/agent-token` (mode 0600).
2. Add `agent-token-file: /etc/platform/k3s/agent-token` to `/etc/rancher/k3s/config.yaml`.
3. Move `/var/lib/rancher/k3s/server/cred/passwd` aside and run `systemctl restart k3s`. k3s recreates the file from the datastore.

Repeat on each server joined that way, one at a time.

### Ingress HA: vip mode

platformctl deploys [kube-vip](https://kube-vip.io) (image pinned in `platformctl/internal/versions`) as a DaemonSet on control-plane nodes, in ARP mode with per-Service leader election. The elected node binds `INGRESS_VIP` to its interface and announces it with gratuitous ARP. k3s ServiceLB is disabled so it does not also claim the Service, and the ingress-nginx Service carries `kube-vip.io/loadbalancerIPs: <INGRESS_VIP>`.

Requirements:

- `INGRESS_VIP` and `API_VIP` must be unused addresses inside the subnet of the VIP interface, not a node address, and not the subnet's network or broadcast address. `provision` checks this, and before kube-vip is first deployed it refuses a VIP that answers ping. ICMP can be filtered, so also keep the address outside any DHCP range. A joining server checks the VIP subnet on its own interface but does not ping the VIPs.
- The network must accept gratuitous ARP and traffic for an address the provider did not assign. Many cloud and VPS networks drop it, and failover then silently does nothing.
- Every node that should be able to hold the VIP must be a k3s server; kube-vip does not run on agents.

**Failover.** kube-vip leases use a 5 s duration, 3 s renew deadline and 1 s retry period. When the holder stops, another server takes the lease within about 5 seconds, so clients see a gap well under 10 seconds. Connections open on the failed node are lost; clients reconnect.

**Client IP.** The ingress Service keeps `externalTrafficPolicy: Local`, so ingress-nginx sees the real client address (needed by the per-IP limits and the API's rate limiters). Only a node with a ready local ingress-nginx pod can serve the VIP, which is why ingress-nginx is a DaemonSet and kube-vip only elects nodes with a local ready endpoint.

**API VIP.** With `API_VIP` set, kube-vip also holds a floating address for the Kubernetes API on port 6443 (lease `plndr-cp-lock` in `kube-system`), and `API_VIP` is added to the k3s serving certificate.

**Manifest copies.** Every server keeps a copy of the kube-vip manifest, so the k3s auto-deploy source survives losing any one server's disk. The copies must be identical, so the manifest is rendered only from the shared settings.

**VIP interface.** With `INGRESS_VIP_INTERFACE` unset (recommended), the manifest has no `vip_interface` and kube-vip binds, on each node, the interface of the default route, and follows it if that route moves. Servers may then use different interface names. When it is set, the interface must exist with that name on every server; `join --role server` refuses to continue when it does not exist locally. Either give the interface the same name everywhere (for example with a systemd `.link` file) or leave it unset on the whole cluster.

### Ingress HA: external mode

No kube-vip is installed and k3s ServiceLB stays enabled: every node answers on 80/443 with its own controller pod. `/healthz` on port 80 is answered by the ingress-nginx default server with 200 on every node; TCP 443 works as an alternative check. Suggested checks: Cloudflare HTTP monitor on `/healthz`, port 80, expected 200, interval 15 to 30 s; Route 53 HTTP check on port 80, path `/healthz`, interval 10 s, failure threshold 2 to 3. platformctl does not configure PROXY protocol.

cert-manager's HTTP-01 challenges reach whichever node answers. Every node runs a controller with the same configuration, so issuance and renewal work regardless.

### Switching ingress modes

Set the new values explicitly (including `INGRESS_HA_MODE`, which is saved in `/etc/platform/.env` and otherwise keeps its previous value) and run `platformctl provision` again on the first server:

- `external` to `vip`: the fragment disables ServiceLB, k3s restarts, the leftover `svclb-*` DaemonSets are deleted and kube-vip takes over the Service address.
- `vip` to `external`: the fragment and the kube-vip manifest are removed, k3s restarts with ServiceLB enabled, and the `kube-vip-ds` DaemonSet is deleted.

Then re-run `platformctl join` with the same new settings on every other server (it rewrites the fragment and the manifest, and restarts k3s when the fragment changed). Write a fresh settings file with `token create --role server --settings-output` and pass it with `--join-settings` to check each server.

Clusters provisioned before kube-vip manifests were written on every server rendered `vip_interface` from the first server's default-route interface. Re-running `provision` on the first server rewrites the manifest without it; re-run `join --role server` on the other servers so their copies match.

Anycast, BGP mode and automating a provider's floating-IP API are not supported.

### Replicated storage (Longhorn)

`provision --profile ha` installs the pinned Longhorn 1.12.1 chart right after k3s, before any workload creates a PVC, and makes `longhorn` the default StorageClass.

**Node prerequisites.** Provision installs `open-iscsi`, `nfs-common`, `util-linux` and `dmsetup`, enables `iscsid`, loads `iscsi_tcp` and persists it in `/etc/modules-load.d/longhorn.conf`. If multipathd is installed, it blacklists only devices with vendor `IET` and product `VIRTUAL-DISK` in `/etc/multipath/conf.d/longhorn.conf`, then reloads it. `join` runs the same step, and checks that `iscsid` is active, on every joining node.

**Settings.** `storageOverProvisioningPercentage: 200` and `storageMinimalAvailablePercentage: 15`, which stops new replicas on a disk that is actually filling up. The manager requests 100m CPU and 128Mi memory per node, limited to one CPU and 1Gi. CSI attacher, provisioner, resizer and snapshotter run two replicas each; the UI runs one.

#### Replicas and default storage

The replica count is chosen from the number of Ready, schedulable nodes when `platformctl install longhorn` runs (during `provision` on the first server, usually with one node; `join` prints a reminder to run it again):

- Three or more nodes: three replicas.
- Two nodes: two replicas. Storage tolerates one node loss; etcd still needs three servers.
- Zero or one node: the desired count stays three; volumes run degraded with one replica until nodes join. `replicaAutoBalance: best-effort` places missing replicas as nodes join.

`LONGHORN_REPLICAS=1`, `2` or `3` overrides the automatic choice; zero, unset or invalid values select auto. An override above the number of nodes leaves volumes degraded. Changing the default does not necessarily change existing volumes' saved replica counts; check them individually.

Once CSI and the provisioner are ready, the installer marks local-path non-default and checks that Longhorn is the only default. It writes `/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip` so k3s does not restore its bundled local-path default on restart. Every k3s server needs this file; `join --role server` creates it. For a server added another way:

```bash
sudo mkdir -p /var/lib/rancher/k3s/server/manifests
printf '# HA storage: Longhorn is the default StorageClass.\n' | sudo tee /var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip
```

Then patch local-path to non-default.

Two more non-default StorageClasses are created:

- `longhorn-minio` for the distributed MinIO drives: `dataLocality: best-effort`, `staleReplicaTimeout: "30"`, and 2 replicas with fewer than 4 nodes, 1 with 4 or more (see [Object storage](#object-storage)).
- `longhorn-single`: one replica, `dataLocality: best-effort`, for the MongoDB and Redis members. The replica set and Sentinel already keep a full copy on each node; three Longhorn replicas per member would store every byte nine times. When a node is lost, its member's volume is unavailable until the node returns; the other two members keep serving.

PostgreSQL defaults to local-path for the same reason (see [PostgreSQL HA](#postgresql-ha-cloudnativepg)).

**UI.** The `longhorn-frontend` service has no Ingress. Run `kubectl -n longhorn-system port-forward svc/longhorn-frontend 8000:80` and open `http://localhost:8000`.

**Alerts.** With monitoring enabled, the `longhorn-monitoring` step applies a ServiceMonitor and the `longhorn.storage` PrometheusRule group (label `release: kube-prometheus`). Alerts: degraded volume (10 min, warning), faulted volume (2 min, critical), node not ready (5 min, critical), disk above 85% (15 min, warning). If the ServiceMonitor CRDs are missing, the step warns and can be rerun later.

**Uninstall.** Uninstalling deletes Longhorn volumes and their data. Export and test off-site backups first and stop workloads. Then:

```bash
kubectl -n longhorn-system patch settings.longhorn.io deleting-confirmation-flag \
  --type=merge -p '{"value":"true"}'
helm uninstall longhorn -n longhorn-system
```

To make local-path the default again, remove the skip file on every server and patch the annotation (restart k3s to restore its bundled manifest if needed):

```bash
sudo rm /var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

Check that only local-path is default before new PVCs are created.

### Datastores

On `ha`, the bundled MongoDB, Redis and MinIO run replicated on Longhorn volumes: MinIO on `longhorn-minio`, MongoDB and Redis on `longhorn-single`. The chart versions are the same pinned Bitnami charts as on one server; only their values change. Members are spread with soft pod anti-affinity, so a cluster that is still growing installs and runs, and pods spread out as nodes join. Each datastore has a PodDisruptionBudget allowing one member down at a time.

`platformctl status` on the first server reports:

```text
  MongoDB replica set rs0: primary mongodb-1.mongodb-headless.databases.svc.cluster.local:27017, 3/3 members ready
  Redis Sentinel mymaster: master redis-node-0.redis-headless.databases.svc.cluster.local:6379
  MinIO distributed: 4/4 pods ready
  Longhorn volumes: 12 healthy
```

The MongoDB member count is the number of ready pods. Status shows `NO PRIMARY (writes fail)` in red when the replica set has no primary, and a warning while fewer than three members are ready. The Longhorn line lists every faulted volume with its PVC and namespace; see [Recover a faulted volume](#recover-a-faulted-volume). With external object storage, the MinIO line shows the endpoint instead.

#### MongoDB replica set

| Setting | Value |
|---|---|
| Architecture | `replicaset`, 3 data-bearing members (`mongodb-0..2`), no arbiter |
| Replica set name | `rs0` |
| Members | `mongodb-N.mongodb-headless.databases.svc.cluster.local:27017` |
| Internal auth | Keyfile derived from the Mongo root password (no extra Secret) |
| Resources | Requests 150m CPU and 512Mi, limits 1 CPU and 1Gi per member |
| Volume | 10Gi `longhorn-single` volume per member |

The API's `MONGODB_URI` lists all three members with `replicaSet=rs0`, and project connection strings carry the same hosts (see [For developers / API](#for-developers--api)). Drivers find the primary from this seed list. When the primary fails, the others elect a new one within about 10 to 15 seconds, and drivers retry writes once (`retryWrites` is on by default), so apps need no restart.

Each member runs the MongoDB exporter sidecar, so `mongodb_*` series are reported per member. Per-project database insights (slow operations from the profiler) read from the current primary. The profiler level is per member, so the API re-enables it on whichever member is primary each time it collects insights.

#### Redis Sentinel

| Setting | Value |
|---|---|
| Nodes | 3 (`redis-node-0..2`), each running Redis and Sentinel |
| Master set | `mymaster`, quorum 2 (down after 5 s, failover timeout 20 s) |
| Sentinel | port 26379 on every node (`redis-node-N.redis-headless.databases.svc.cluster.local:26379`) |
| Compatibility service | `redis-master.databases` follows the current master (the chart's master Service) |
| Volume | 5Gi `longhorn-single` volume per node |

The API finds the master through Sentinel (`REDIS_SENTINEL_HOSTS` and `REDIS_SENTINEL_MASTER` in `platform-env`). After a failover it reconnects on its own, and a command rejected by a demoted master (`READONLY`) is retried on the new one.

Redis does not replicate ACL users, so the API creates every per-project Redis user, and its own `plat-api` user, on every node. The `redis-acl-reconcile` leader job checks all nodes every 15 seconds and re-creates missing users, so a promoted replica already has them.

`plat-sentinel` is a shared, discovery-only Sentinel user: it can ask where the master and replicas are, but cannot reconfigure Sentinel, trigger a failover or read data. Apps never receive the platform Redis password. The SDK helpers (sdk-node and sdk-python `RedisManager`) use Sentinel automatically when the Sentinel fields are present. Clients that ignore them use `host` (the compatibility service), which can lag behind a failover. Project namespaces' network policy allows TCP 6379 and 26379 to the Redis pods. Each node runs the Redis exporter sidecar.

The portal rotates the platform Redis password live on every data node and Sentinel on `ha`. It updates replication authentication before node passwords, then Sentinel monitoring and peer authentication, and finally the Redis Secret and platform credentials. Existing API, project and SDK discovery ACL credentials remain usable. Writable runtime configuration is persisted; the chart regenerates configuration from the Secret on restart. If interrupted, retry **Rotate all secrets** to continue with the saved password pair, checking each member individually. See [Rotate Cairn's own passwords](../deployment/update-secrets.md). `sudo platformctl recover` remains the break-glass recovery path and restarts Redis nodes.

#### Object storage

| Setting | Value |
|---|---|
| Mode | MinIO `distributed`, 4 pods with one drive each (`minio-0..3`) |
| Erasure coding | Default parity EC:2: reads survive losing 2 drives, writes need 3 of 4 |
| Volume | 25Gi per drive on `longhorn-minio` (100Gi of drives, about 50Gi usable) |
| Placement | Soft pod anti-affinity; a PodDisruptionBudget allows one pod down at a time |
| Endpoint | unchanged: `http://minio.storage:9000` (Service `minio`) |

Every consumer keeps using the `minio` Service: API uploads and backups (`platform-uploads`, `platform-backups`), session replays (`replays`), Loki, Tempo and Pyroscope storage, and `platformctl backup`. The installer creates the default buckets itself, because the chart only does so in standalone mode. The console and SSO are unchanged.

Erasure coding stores each usable gigabyte on about 2 GB of drives. The Longhorn replica count per drive depends on the Ready schedulable nodes when `platformctl install longhorn` runs:

| Nodes | Longhorn replicas per drive | Disk per usable GB | When one node is down |
|---|---|---|---|
| 1 | 2 (one scheduled until a second node joins) | about 2 GB, 4 GB once a second node joins | No HA: MinIO is down with the node |
| 2 or 3 | 2 | about 4 GB | Reads continue. One node holds two of the four drives; while it is down, writes pause. Longhorn deletes the stuck pods (the installer sets its node-down pod deletion policy), Kubernetes reschedules them, by default about 5 to 6 minutes after the node becomes unreachable, and their volumes attach elsewhere from the second replica. Writes then resume |
| 4 or more | 1 | about 2 GB | Each drive is on its own node, so reads and writes continue with 3 of 4 drives. The lost drive's pod stays Pending until the node returns |

StorageClass parameters cannot change in place, so when the count must change the installer deletes and recreates `longhorn-minio`. Existing volumes keep their count; only new ones use it. To change existing MinIO volumes, use the Longhorn UI (Volume, Update Replicas Count) or:

```bash
# MinIO volumes and their replica counts (the Longhorn volume name is the PV name)
kubectl get pv -o custom-columns=PV:.metadata.name,CLAIM:.spec.claimRef.name,SC:.spec.storageClassName | grep longhorn-minio
kubectl -n longhorn-system get volumes.longhorn.io -o custom-columns=NAME:.metadata.name,REPLICAS:.spec.numberOfReplicas
# set the replica count of one volume
kubectl -n longhorn-system patch volumes.longhorn.io <pv-name> --type merge -p '{"spec":{"numberOfReplicas":2}}'
```

Raise the count to 2 before the cluster drops below four nodes; lower it to 1 only once each MinIO pod runs on its own node. Apps can also keep their own files in an external bucket through [storage providers](storage-providers.md); bundled mode keeps the platform's own data in MinIO. Fresh installs can instead use the external option below.


#### External object storage (fresh installs only)

Set `OBJECT_STORAGE_MODE=external` to use an S3-compatible endpoint for Cairn's
own data and the default app storage provider. This works on every profile; the
interactive `ha` installer asks which mode to use. The default remains `bundled`.
Moving an existing bundled installation to external storage is not supported.

For a non-interactive fresh install, pass non-secret settings as flags (or use
the corresponding `OBJECT_STORAGE_*` environment variables):

```bash
# The protected file contains exactly two lines: access key ID, secret access key.
sudo platformctl provision --auto --profile ha \
  --object-storage-mode external \
  --object-storage-endpoint https://s3.eu-west-1.amazonaws.com \
  --object-storage-region eu-west-1 \
  --object-storage-bucket-prefix my-cairn \
  --object-storage-force-path-style=false \
  --object-storage-credentials-stdin < /secure/object-storage-credentials
```

Credentials are never accepted as flags or saved to `/etc/platform/.env`. They
are sent on stdin to Kubernetes Secret `platform/platform-object-storage`, with
keys `OBJECT_STORAGE_ACCESS_KEY` and `OBJECT_STORAGE_SECRET_KEY`. On reruns, the
installer reuses this Secret; it may also be supplied before provisioning when
using an existing cluster. Interactive installs can enter credentials at hidden
prompts. Keep credentials out of shell history and logs. Consumers that need
another Secret format receive a namespace-local copy.

Buckets are `<prefix>-uploads`, `<prefix>-backups`, `<prefix>-replays`,
`<prefix>-loki`, `<prefix>-tempo`, `<prefix>-pyroscope`, and `<prefix>-registry`.
Before k3s starts, the installer checks each bucket, creates missing buckets
through S3, and writes, reads back and deletes a temporary probe object. A failed
probe stops provisioning. Pre-create buckets when your provider does not support
S3 bucket creation (including providers requiring their own bucket-management API).
The endpoint must be reachable both from the provisioning host and cluster pods;
for direct upload URLs it must also be reachable by clients.

The key needs `s3:ListBucket`, `s3:GetBucketLocation`,
`s3:ListBucketMultipartUploads` on these buckets, plus `s3:GetObject`,
`s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`, and
`s3:ListMultipartUploadParts` on their objects. `s3:CreateBucket` is needed only
when buckets do not already exist. Scope the key to this installation's buckets
using the provider's IAM controls. Use R2's S3 endpoint with region `auto`, or
GCS's S3 interoperability endpoint with HMAC credentials; native GCS service
account JSON is not an S3 credential.

External mode skips MinIO, its IAM bootstrap, console/SSO routes, the `storage`
namespace and the `longhorn-minio` StorageClass. If an install already has a
`storage` namespace from bundled mode, the installer leaves it and its volumes
alone; it never deletes them. API uploads, replays, backups, telemetry and the
build registry use the configured endpoint, region and addressing mode. The
installer does not manage external IAM users, console SSO or lifecycle policies.
Configure bucket lifecycle, multipart-upload cleanup, retention, versioning and
replication at your provider. For browser uploads, configure bucket CORS to allow
your portal origin and the required GET, PUT and HEAD methods. Keep lifecycle expiry at least as long as Cairn's
configured retention and PostgreSQL recovery window.

Bundled MinIO expires session replay objects after 365 days as a backstop
(per-project retention is applied by the API); add an equivalent lifecycle rule
for the `replays/` prefix of `<prefix>-replays` if you want the same limit.

Use an `https://` endpoint whose certificate is trusted by the public CA bundle,
as for the [backup target](backups.md); a private or self-signed CA is not
supported. Plain `http://` works only on a private network you trust. Path-style
requests (`OBJECT_STORAGE_FORCE_PATH_STYLE=true`, the default) work with most
S3-compatible stores; with `false`, requests go to `<bucket>.<endpoint host>`,
so the endpoint's certificate must cover that name. The bucket prefix may not
contain dots for the same reason.

Rotating the access key is not automated yet: the installer copies the key from
`platform/platform-object-storage` into the telemetry, registry and PostgreSQL
backup Secrets when those components are installed.

Unless a separate backup target or explicit local-backup choice is supplied,
`<prefix>-backups` also becomes the existing external backup target for PostgreSQL
WAL/base backups, encrypted `platformctl backup` archives, etcd snapshots and
Longhorn backups. An explicitly configured backup target keeps precedence; see
[backups](backups.md). With an explicit local-backup choice, encrypted archives stay local while
PostgreSQL still uses external object storage rather than a missing MinIO service.
Encrypted archive defaults omit the bundled `minio` capture component: external
bucket contents need provider-managed protection and are not mirrored into the
archive. Enable encrypted archives with `platformctl backup init --recipient ...`
and `platformctl backup schedule` as usual.

#### Migrating an existing single-node install

The installer does not convert single datastore instances in place: standalone MongoDB keeps its data on a different volume than the replica set, Redis moves from the `redis-master`/`redis-replicas` StatefulSets to `redis-node`, and standalone MinIO data is not erasure-coded. When it finds a standalone MongoDB, a `redis-master` StatefulSet or a standalone MinIO on an install whose profile is now `ha`, `provision` and `upgrade` stop with an error that links here, and change nothing.

Migrate with a backup and restore:

1. Configure encrypted backups and take a full backup (see [Backups](backups.md)): `sudo platformctl backup --all`.
2. Stop writers: scale the platform API and project apps to zero.
3. Check the backup with `sudo platformctl backup list`; it is about to be the only copy. Remove the single instances and their volumes:

   ```bash
   helm -n databases uninstall mongodb redis
   helm -n storage uninstall minio
   kubectl -n databases delete pvc -l app.kubernetes.io/instance=mongodb
   kubectl -n databases delete pvc -l app.kubernetes.io/instance=redis
   kubectl -n storage delete pvc -l app.kubernetes.io/instance=minio
   ```

4. Remove the `mongodb`, `mongodb.values`, `redis`, `redis.values` and `minio` lines from `/etc/platform/.bootstrap_state` (keep a copy), then run `sudo platformctl provision --profile ha`.
5. Restore the data, streaming the age identity as for any restore: `sudo platformctl restore --from <ID> --component mongo --confirm`, then the same for `redis` and `minio`.
6. Start the API and apps again. Apps get the new MongoDB and Redis settings the next time they request database credentials (the SDKs do this on start), or when redeployed.

### PostgreSQL HA (CloudNativePG)

The `ha` profile installs the CloudNativePG (CNPG) operator (chart 0.29.1, operator 1.30.1) in `cnpg-system` and a `postgresql` Cluster in `databases`, using PostgreSQL 18.6 (the CNPG `system` image, which includes pgaudit). Fresh single-node installs run the same operator with one instance. An existing Bitnami release, StatefulSet or Helm-managed `postgresql` Service blocks the install without changing its data; see [Migrating from a single-node install](#migrating-from-a-single-node-install).

**Operator.** On `ha` the operator runs two replicas with leader election, spread over the nodes by a topology spread constraint, and an operator pod on a failed node is replaced after 30 seconds. The other profiles run one replica. The operator is installed while only the first server exists, so both replicas start there; `sudo platformctl install longhorn`, the step you run after the joins, restarts the operator once more servers are Ready so the replicas move apart. Only the operator restarts, not the database. `platformctl status` warns while both replicas are on one node: if that node fails, no operator is left to promote a standby, and in a power-off test with no operator on the surviving servers promotion took about two minutes.

**Topology.** Three instances run on separate nodes (required pod anti-affinity). With `POSTGRES_REPLICATION=sync` (the default), one quorum synchronous standby acknowledges writes: no acknowledged write is lost while a synchronous standby is available. `dataDurability: preferred` lets the primary keep accepting writes when no standby is available (initial provisioning on one node, or two database nodes lost); such writes lack the synchronous guarantee. With `POSTGRES_REPLICATION=async`, the `synchronous` stanza is left out: commits do not wait for a standby, but the last acknowledged writes can be lost when the primary's server fails. Failover after a node loss takes about 1 to 2 minutes in both modes. Switch live with `sudo platformctl postgres replication set sync|async` (a configuration reload, no restart). See [Synchronous or asynchronous database replication](postgres-replication.md). On the first server only the primary needs to become Ready; the standbys stay Pending until nodes join. CNPG manages PodDisruptionBudgets for voluntary disruptions.

**Resources and storage.** Each instance requests 100m CPU and 512Mi, is limited to two CPUs and 1Gi, and has a 10Gi volume. `POSTGRES_HA_STORAGE_CLASS` defaults to `local-path` even though Longhorn is the cluster default: PostgreSQL replicates its own data, and Longhorn replicas underneath would store each write nine times and move WAL fsync across the network. Set a different DNS-1123 StorageClass name before creating the Cluster if needed; changing an existing volume's class needs a storage migration.

**Endpoints.** Apps keep using `postgresql.databases:5432`, a ClusterIP alias selecting the primary (equivalent to `postgresql-rw.databases:5432`). Read-only clients can use `postgresql-ro.databases:5432`; CNPG also creates `postgresql-r`. The API connects as `postgres` to `platform`; CNPG's generated `postgresql-app` Secret is unused.

**Credentials.** The installer creates the `databases/postgresql` Secret only if absent, type `kubernetes.io/basic-auth`, with `username: postgres` and equal `password` and `postgres-password` keys. CNPG reads `password`; the platform reads `postgres-password`. API rotation and `platformctl recover` keep both equal; re-provision never overwrites the Secret. Recovery checks passwords over TCP because CNPG's local socket uses peer authentication.

**Monitoring.** With monitoring enabled, `postgresql-monitoring` installs the `postgresql` PodMonitor and `postgresql-ha` PrometheusRule in `monitoring`. Relabeling keeps `pg_up` and `project_database_*` compatible with [database monitoring](database-monitoring.md). Alerts: an instance down for 5 minutes, no primary for 2 minutes, replication lag over 60 seconds for 10 minutes, WAL archive failures, and a newest backup older than two days.

`platformctl status` prints the Cluster phase, ready and desired count, the primary, both endpoints, the replication mode (`sync` or `async`), WAL archiving (`ok`, `FAILING` or `not configured`), the last successful backup and the first recoverability point. It warns when fewer than three instances are ready. Details:

```bash
kubectl -n databases get cluster postgresql
kubectl -n databases get pods -l cnpg.io/cluster=postgresql -o wide
kubectl -n databases describe cluster postgresql
```

#### Continuous WAL and daily backups

WAL archiving and base backups run through the CloudNativePG Barman Cloud plugin (`barman-cloud.cloudnative-pg.io`, v0.15.1). The plugin runs in `cnpg-system` as one replica that moves off a failed node after 30 s, and injects a sidecar into each PostgreSQL pod that ships WAL to the object store, so archiving and failover do not depend on the plugin pod. Its link to the operator uses cert-manager certificates. The destination lives in the `ObjectStore` resource `databases/postgresql-backup`.

The `postgresql-backup` step runs after PostgreSQL, MinIO, cert-manager and the platform API. By default it archives to `<prefix>/postgres/` in the [backup target](backups.md#the-backup-target), with credentials from the `databases/platform-backup-s3` Secret. Only with local-only backups does it create `s3://postgres-backups/` in the bundled MinIO, with a scoped `postgres-backup` user and a bucket-only policy (Secret `postgresql-backup-s3`); the bundled MinIO is not off-site.

To archive somewhere other than the backup target, create a Secret (credentials already in your shell environment):

```bash
kubectl create namespace databases --dry-run=client -o yaml | kubectl apply -f -
kubectl -n databases create secret generic postgresql-external-s3 \
  --from-literal=ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  --from-literal=ACCESS_SECRET_KEY="$S3_SECRET_KEY"
```

Then set, and run `sudo platformctl install postgresql-backup`:

```dotenv
POSTGRES_BACKUP_DESTINATION=s3://offsite-backups/postgresql/
POSTGRES_BACKUP_ENDPOINT=https://s3.example.com
POSTGRES_BACKUP_SECRET=postgresql-external-s3
POSTGRES_BACKUP_RETENTION=14d
```

The endpoint is optional for the provider's default S3 endpoint. A destination needs a Secret name; credentials never go into `.env`. WAL is gzip-compressed. The daily base backup (`ScheduledBackup` `postgresql-daily`) runs at 03:00 UTC (`0 0 3 * * *`, CNPG's six-field cron), with an immediate first backup. Provision waits for `ContinuousArchiving=True`. Check errors with `kubectl -n databases describe cluster postgresql` and `kubectl -n cnpg-system logs deploy/barman-cloud`. The recovery window is in the ObjectStore status:

```bash
kubectl -n databases get objectstores.barmancloud.cnpg.io postgresql-backup -o jsonpath='{.status.serverRecoveryWindow}'
```

CNPG refuses a non-empty WAL archive for a newly created Cluster. Re-provisioning after deleting the Cluster needs a new bucket or prefix; do not erase the old archive needed for recovery.

**Migrating from in-tree archiving.** Clusters provisioned by earlier releases archive with `spec.backup.barmanObjectStore`. `sudo platformctl install postgresql-backup` moves them to the plugin in place, keeping the same destination, credentials and `serverName`, so the archive continues without a gap. `platformctl restore --pitr` refuses a cluster that still archives in-tree. Afterwards, check for `WAL archiving: ok (Barman Cloud plugin)` in `platformctl status` and request a base backup.

#### Point-in-time recovery (PITR)

`sudo platformctl restore --pitr <RFC3339 time> --confirm` takes a past timestamp at or after the first recoverability point. It uses the live ObjectStore's settings, without `--from` or an age identity. It stops the API, switches and archives the primary's WAL, deletes and recreates the Cluster, and waits for the recovered primary. Database volumes are replaced; all databases return to that time. It always tries to resume the API, also on failure, and reports resume errors.

The restored Cluster writes to a new `postgresql-pitr-<unix seconds>` serverName; the old archive is never written again. A fresh base backup is requested and the daily schedule stays active. Check the new backup and recoverability point before relying on further PITR. Retention prunes only the current serverName: delete the old one's objects yourself when you no longer need them.

#### Failover verification

With all three instances Ready and a test app writing through the read-write endpoint, in a planned window:

```bash
primary=$(kubectl -n databases get pod -l cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
kubectl -n databases delete pod "$primary"
kubectl -n databases get cluster postgresql -w
```

Also test powering off the primary's node, with etcd quorum and two database nodes still available. Expect a new primary about 30 seconds after deleting the pod, and about 1 to 2 minutes after powering off the node (Kubernetes has to notice the node is gone first). Check that writes resume, acknowledged data remains, and the returning instance rejoins as a standby. Do not remove more nodes while the cluster is degraded.

#### Migrating from a single-node install

Move a Bitnami PostgreSQL release to CloudNativePG with one command, on the first server, during a short downtime window:

```bash
sudo platformctl postgres migrate --dry-run
sudo platformctl postgres migrate --confirm
```

It takes a backup, stops the API and project database logins, dumps every database, keeps the old volume for rollback, restores into the new cluster, verifies the result and turns on WAL archiving. A failed run continues from the last finished step when you run it again; `--rollback --confirm` returns to the Bitnami release. The steps are listed in [Moving PostgreSQL to CloudNativePG](backups.md#moving-postgresql-to-cloudnativepg). On a server whose `.env` already says `PLATFORM_PROFILE=ha`, the new cluster has three instances. Switching `ha` back to a single-node profile is not supported.

### Upgrades

k3s is pinned per platformctl release. `platformctl upgrade` re-applies the CNPG operator chart and the `postgresql` Cluster; only spec changes roll the instances (standbys first, then a switchover, a few seconds of reconnects). It also re-applies the pinned Longhorn chart with `helm upgrade`; Longhorn upgrades engines live. Read the Longhorn upgrade notes first, move one minor version at a time, and check volume health and backups.

Switching an existing install to `ha` does not move existing local-path PVCs. Use `platformctl backup` and `platformctl restore` for supported data, or a per-volume copy Job into a new Longhorn PVC, with writers stopped during the final copy.

### etcd snapshots

Every server takes etcd snapshots on a schedule:

| Variable | Default | Meaning |
|---|---|---|
| `ETCD_SNAPSHOT_CRON` | `0 */6 * * *` | Snapshot schedule |
| `ETCD_SNAPSHOT_RETENTION` | `28` | Snapshots kept per node |
| `ETCD_S3_ENDPOINT` | | S3 endpoint (`s3.example.com`); enables upload together with `ETCD_S3_BUCKET` |
| `ETCD_S3_BUCKET` | | Bucket |
| `ETCD_S3_REGION` / `ETCD_S3_FOLDER` | | Optional region and folder |
| `ETCD_S3_ACCESS_KEY` / `ETCD_S3_SECRET_KEY` | | Credentials |

Without these settings, snapshots go to `<prefix>/etcd/` in the [backup target](backups.md#the-backup-target): `config.yaml` names the Secret `kube-system/platform-etcd-s3` (`etcd-s3-config-secret`) and holds no key. Joining servers get the same setting from the join settings file (`ETCD_S3_CONFIG_SECRET`), so pass `--join-settings` to every `join --role server`. A server that joined without it, or with an older `platformctl`, takes no off-site snapshots. To fix it, re-run `join` on that server with a fresh settings file. This restarts k3s on that server only. Set the `ETCD_S3_*` variables before `provision` and `join --role server`. Explicit S3 credentials are stored in `/etc/rancher/k3s/config.yaml` (mode 0600). Use an off-site bucket: the bundled MinIO runs inside the cluster it would have to restore. List snapshots with `k3s etcd-snapshot ls`. Restore with the k3s procedure (`k3s server --cluster-reset --cluster-reset-restore-path=<snapshot>` on one server, then rejoin the others). `platformctl backup --all` also puts an etcd snapshot in its encrypted archive.

### Longhorn backups to S3

Create a Secret in `longhorn-system` (credentials already in your shell environment):

```bash
kubectl create namespace longhorn-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n longhorn-system create secret generic longhorn-backup \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_ENDPOINTS="$AWS_ENDPOINTS"
```

Then set:

```dotenv
LONGHORN_BACKUP_TARGET=s3://platform-backups@us-east-1/longhorn/
LONGHORN_BACKUP_SECRET=longhorn-backup
```

Only the target and Secret name are saved in `.env`. Without them, Longhorn uses `<prefix>/longhorn/` in the [backup target](backups.md#the-backup-target) with the Secret `longhorn-system/platform-longhorn-backup`. Whenever a target is set, the RecurringJob `platform-backup-daily` backs up every volume in the `default` group at 01:30 UTC and keeps 7. The in-cluster MinIO is not an off-site target.

### Checking the setup

```bash
kubectl get nodes                                         # 3 servers (control-plane,etcd) and the agents Ready
kubectl get storageclass                                  # only longhorn is default
kubectl -n kube-system get lease | grep -i -e kubevip -e plndr
kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-vip -o wide
ip -4 addr show dev <iface>                               # on the holder: INGRESS_VIP/32 is listed
kubectl -n ingress-nginx get svc ingress-nginx-controller # EXTERNAL-IP = INGRESS_VIP
kubectl -n ingress-nginx get ds                           # one controller per node
```

After powering off a server, workloads on it are rescheduled after the eviction timeout and their Longhorn volumes reattach on a healthy node. When it comes back, Longhorn rebuilds its replicas until volumes are healthy. Also test restoring a Longhorn backup from the off-site target.

## For developers / API

On `ha`, every project MongoDB connection string returned by `GET /api/sdk/db-credentials` (and stored as the project secret `MONGO_URI`) lists all three members with the project's own user:

```text
mongodb://plat_<id>_<env>_user:<password>@mongodb-0.mongodb-headless.databases.svc.cluster.local:27017,mongodb-1.mongodb-headless.databases.svc.cluster.local:27017,mongodb-2.mongodb-headless.databases.svc.cluster.local:27017/plat_<id>_<env>?replicaSet=rs0&authSource=plat_<id>_<env>
```

Connection strings issued before the switch to `ha` name the old single host: request credentials again (the SDKs do this on start) or redeploy the app.

For Redis, the response keeps `host`, `port`, `username`, `password` and `keyPrefix`, and on `ha` adds the Sentinel settings. Project apps get the same values as the secrets `REDIS_SENTINELS`, `REDIS_SENTINEL_MASTER`, `REDIS_SENTINEL_USERNAME` and `REDIS_SENTINEL_PASSWORD`.

```json
{
  "redis": {
    "host": "redis-master.databases",
    "port": 6379,
    "username": "plat_<id>_<env>",
    "password": "…",
    "keyPrefix": "plat:<id>:<env>:",
    "db": 0,
    "sentinels": [
      { "host": "redis-node-0.redis-headless.databases.svc.cluster.local", "port": 26379 },
      { "host": "redis-node-1.redis-headless.databases.svc.cluster.local", "port": 26379 },
      { "host": "redis-node-2.redis-headless.databases.svc.cluster.local", "port": 26379 }
    ],
    "masterName": "mymaster",
    "sentinelUsername": "plat-sentinel",
    "sentinelPassword": "…"
  }
}
```

PostgreSQL apps need no change: `postgresql.databases:5432` always points at the primary.

## Related

- [Host hardening](../guides/host-hardening.md)
- [Backups](backups.md)
- [Synchronous or asynchronous database replication](postgres-replication.md)
- [Upgrade](upgrades.md)
- [Scaling](../deployment/scaling.md)
- [platformctl CLI](../getting-started/platformctl.md)
