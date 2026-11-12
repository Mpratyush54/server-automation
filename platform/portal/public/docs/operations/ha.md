# High availability (ha profile)

## Replicated storage (Longhorn)

With `platformctl provision --profile ha`, the installer installs the pinned
Longhorn 1.12.1 chart before workloads create PVCs and makes `longhorn` the default
StorageClass. Allow roughly 500 MB or more RAM per node for storage services,
plus disk overhead for replicas, snapshots and rebuilds. The `minimal`, `standard`
and `full` single-node profiles keep k3s local-path storage unchanged.

### Node prerequisites

Provision installs `open-iscsi`, `nfs-common`, `util-linux` and `dmsetup`, enables
`iscsid`, loads `iscsi_tcp`, and persists the module in
`/etc/modules-load.d/longhorn.conf`. If multipathd is installed, it blacklists
only devices with vendor `IET` and product `VIRTUAL-DISK` in
`/etc/multipath/conf.d/longhorn.conf`, then reloads the active service.
Nodes added later need these same prerequisites before hosting replicas
(`platformctl join` is expected to run the same step, `apt.InstallLonghornPrereqs`;
until it does, run `sudo platformctl install longhorn` on the first server after
installing `open-iscsi nfs-common` and enabling `iscsid` on the new node).

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
volumes degraded. After joins, rerun `platformctl install longhorn` to reconcile
the replica setting. Check existing volumes individually: changing defaults does
not necessarily change their saved replica counts.

Once CSI and the provisioner are ready, the installer marks local-path non-default
and verifies that Longhorn is the only default. It writes
`/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip` to stop k3s from
restoring its bundled local-path default on restart. **Every k3s server node
needs this file**, including servers added later. For an added server:

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

### Backups to S3

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

### Alerts and networking

The `longhorn-monitoring` step runs after monitoring for HA installs with
monitoring enabled. It applies a ServiceMonitor for manager metrics and the
`longhorn.storage` PrometheusRule group, labeled `release: kube-prometheus`.
Alerts cover degraded volumes (10m, warning), faulted volumes (2m, critical),
nodes not ready (5m, critical), and disk usage above 85% (15m, warning). If
ServiceMonitor CRDs are missing, the step warns and can be rerun later.

No extra host firewall ports are required. Longhorn traffic stays on the pod
network/CNI interfaces already trusted by the host firewall; iSCSI is node-local.

### Upgrades and migration

`platformctl upgrade` reapplies the pinned chart using `helm upgrade`; Longhorn
upgrades engines live. Read the Longhorn upgrade notes before upgrading and
advance one minor version at a time. Check volume health and tested backups first.

Switching the default does not migrate existing local-path PVCs. Use
`platformctl backup` and `platformctl restore` for supported application data,
or a per-volume copy Job into a new Longhorn PVC. Plan downtime, stop writers
during the final copy, and verify the restored application before removing old data.

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

### Verification (multi-node)

- [ ] Confirm all storage nodes are Ready and schedulable, with prerequisites
  installed and the skip file on every server.
- [ ] Run `kubectl get storageclass` and confirm only `longhorn` is default;
  check `kubectl get csidriver driver.longhorn.io` and the CSI provisioner rollout.
- [ ] Create a test PVC using the default class, mount it in a pod, write data,
  and confirm provisioning, attachment and the expected healthy replica count.
- [ ] Take a storage node down in a test environment; verify the volume survives
  node loss and the application reattaches on a healthy node with its data intact.
- [ ] Restore or replace the node and verify replica rebuild completes and volume
  health returns to healthy. Maintain three etcd servers when testing control-plane loss.
- [ ] Verify a backup and restore from the off-site S3 target.
