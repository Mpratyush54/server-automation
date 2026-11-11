# Single-node host and ingress security baseline

`sudo platformctl provision` applies the Ubuntu baseline by default. Use
`--skip-hardening` or `PLATFORM_HARDEN=false` when another system manages host
security. The choice is saved in `/etc/platform/.env`. Skipping does not undo
previous hardening. Ingress protections remain enabled independently.

Reconcile a running installation with `sudo platformctl harden --auto` (set
`PLATFORM_HARDEN=true` if previously opted out). Root, systemd, apt, and a healthy
single-node k3s installation are required. There is no unattended distro upgrade
or automatic reboot. `platformctl status` reports baseline completion, whether
SSH remains password-enabled, pending firewall confirmation, and Ubuntu's
`/var/run/reboot-required` notification. State is last-application state, not a
continuous compliance audit. Re-running reconciles identical config contents
without rewriting them; drift is repaired and firewall confirmation is repeated.

## Host configuration

- Security-only unattended-upgrades, including applicable Ubuntu ESM security
  pockets, are configured in `99-platform-security`. Daily apt timers are
  enabled; automatic reboot is disabled. Schedule an operator-controlled reboot
  when status reports one. Test with `sudo unattended-upgrades --dry-run --debug`.
- SSH uses `/etc/ssh/sshd_config.d/60-platform.conf`. Password and keyboard
  interactive authentication are disabled only with an unrestricted parseable
  key in root's or `SUDO_USER`'s standard `authorized_keys`. Group/world-writable
  keys or home/.ssh directories do not pass the guard. Restricted/forced-command
  keys do not qualify. Missing keys emit a preflight warning and retain existing
  authentication. Add a real operator key and rerun. Root uses
  `PermitRootLogin prohibit-password`. `sshd -t` and effective `sshd -T` settings
  must pass before reload. Failed validation restores the previous managed
  drop-in (or removes a newly created one). Earlier cloud-init/SSH settings that
  override this policy cause an error for the operator to resolve; platformctl
  does not silently rewrite vendor files. Custom authorized-key locations or
  multi-factor AuthenticationMethods require operator-managed SSH.
- fail2ban's sshd jail uses journald and nftables bans: five attempts in ten
  minutes incur a one-hour ban. `--nginx-auth-jail` /
  `PLATFORM_NGINX_AUTH_JAIL=true` additionally enables `nginx-http-auth` against
  `/var/log/platform/ingress-error.log`. First export the ingress controller's
  **nginx error stream** in native nginx format to that root-managed, rotated
  host file (for example with your log collector). Raw CRI access logs are not
  compatible. The optional jail fails early if this file is absent; no default
  host mounts or log collector are added.
- chrony is installed and enabled. `chronyc waitsync` must converge within about
  thirty seconds; lack of reachable time sources fails the step. Review
  `chronyc tracking` if this fails. Clock sync is necessary for TOTP and TLS.

## Firewall and rollback

Only the `inet platform_guard` nftables table is owned by platformctl. Input and
forward chains run at filter priority 10, after k3s' standard iptables filter
hooks; drops in other chains (including fail2ban) still win. There is no global
ruleset flush, OUTPUT policy, or replacement of kube-proxy/flannel NAT rules.
UFW is not enabled or disabled. Existing operator firewalls may impose further
restrictions and must be reconciled by their owner.

| Traffic | Policy |
| --- | --- |
| TCP 22 | Public SSH on the standard port |
| TCP 80, 443 | Public ingress; DNAT forwarding uses original destination ports |
| TCP 6443, 10250 | Host loopback and internal pod interfaces only; closed to external clients |
| cni0, flannel.* | Trusted internal traffic, including pod/service routing |
| Established/related | Allowed, preserving existing SSH sessions and reply traffic |
| ICMP / ICMPv6 | Allowed, including IPv6 neighbor discovery and path MTU |
| DHCP client replies | Allowed for host address renewal |
| Other new inbound/forwarded connections | Dropped, including external NodePorts and overlay traffic |

Pod/service CIDRs default to k3s' standard IPv4 ranges and are read from
`/etc/rancher/k3s/config.yaml` (scalar, comma-separated, inline-list, block-list,
and dual-stack forms). CIDR source rules are constrained to internal interfaces
to avoid trusting spoofed external source addresses. Config fragment directories
are refused rather than guessed. Existing multi-node clusters are refused before
any host changes. This is deliberately a single-node policy: use
`--skip-hardening` and operator-managed node allowlists for multi-node/HA hosts,
nonstandard SSH ports, or future `platformctl join` (#53). Remote kubectl clients
need an SSH tunnel rather than direct public 6443 access.

The previous **owned table** is captured, generated rules are syntax-checked, and
a transient systemd rollback is armed for 120 seconds **before** atomic policy
replacement. Rejection/failure restores that table immediately; failure of the
immediate rollback leaves the independent timer armed. A pending transaction
cannot be overwritten by another run. Only confirmed rules are persisted in
`/etc/platform/firewall.nft` and loaded by `platform-firewall.service` on boot.
The distro nftables service is not enabled, since its default global flush could
erase k3s rules. An interrupted transaction's marker is retained until rollback.
After a reboot clears transient timers, the next run first restores that saved
transaction if both its timer and service are inactive, then reconciles again.

The `harden` host step runs after prerequisites **and after cluster routing is
ready**. This intentionally differs from applying the firewall before k3s:
initial install can exceed the rollback window, and automatic confirmation must
not accept missing ingress. Confirmation checks local TCP 22/80/443/6443, an sshd
listener, and `/api/health/ready` through loopback HTTPS with the platform Host.
The readiness check permits the bootstrap/internal certificate and bypasses
public DNS and proxies. In `--auto` mode all these checks must pass. Interactive
mode additionally asks the operator to verify a **new** SSH login and external
portal access, then type `confirm` within 90 seconds. Local checks cannot prove
external reachability: retain console access during the first install.

## Ingress defaults and optional WAF

The controller ConfigMap's `http-snippet` creates per-client request and
connection zones: 1,000 requests/second, burst 2,000, and 2,000 concurrent connections
per client IP by default; rejections return 429. Limits apply per controller
replica to **all ingress traffic**, including customer applications. These higher
defaults accommodate users sharing office or carrier NAT addresses.

| Environment variable | Default | Allowed values |
| --- | --- | --- |
| `INGRESS_IP_RATE_LIMIT` | `1000` requests/second | `0` or `1-1000000` |
| `INGRESS_IP_BURST` | `2000` requests | `0` or `1-1000000` |
| `INGRESS_IP_CONNECTIONS` | `2000` concurrent connections | `0` or `1-65535` |

Invalid values produce a warning and fall back to the corresponding default.
Set `INGRESS_IP_RATE_LIMIT=0` to omit the request limiter and its zone;
`INGRESS_IP_CONNECTIONS=0` omits the connection limiter and its zone.
`INGRESS_IP_BURST=0` omits the burst allowance (`burst` and `nodelay`), keeping
request rate limiting active without a burst. Burst has no effect when the
request rate limit is disabled.

Settings are saved in `/etc/platform/.env` and loaded again on subsequent runs.
Edit that file or override it with environment variables, then reconcile:

```bash
sudo INGRESS_IP_RATE_LIMIT=5000 INGRESS_IP_BURST=10000 INGRESS_IP_CONNECTIONS=4000 platformctl install ingress-nginx
```

The command saves these settings for future reconciliations. The controller
continues to use `externalTrafficPolicy: Local`, ignore forwarding headers,
and reject excess traffic with status 429. Limits use actual nginx directives,
not unsupported ConfigMap `limit-rps` keys. See the upstream
[ConfigMap reference](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/).

### Client source IPs

Per-IP limits only work when nginx sees the real client address. The controller
Service uses `externalTrafficPolicy: Local`: k3s routes traffic for the
LoadBalancer address (the node IP) straight to the local controller pod without
SNAT. With the previous `Cluster` policy every request arrived from the CNI
gateway (`10.42.0.1`), so the nginx zones above and the API's per-IP limiters
(login, credentials, ingest endpoints) were one bucket shared by all clients.

* Forwarding headers are not trusted: `use-forwarded-headers`,
  `compute-full-forwarded-for` and `use-proxy-protocol` are `false`. nginx sets
  `X-Forwarded-For` to the TCP peer, overwriting anything the client sent, and the
  API trusts exactly one proxy hop (`trust proxy = 1`). Clients cannot spoof their
  address to dodge limits.
* Under `Local`, k3s ServiceLB (svclb) forwards to `<node IP>:<node port>`
  instead of the ClusterIP, so node ports are allocated again. Without them
  host-local access such as `https://127.0.0.1` (used by the `harden` readiness
  check) fails. The host firewall's forward chain only admits connections whose
  original destination port is 80/443, so node ports stay closed externally on
  hardened hosts; on `--skip-hardening` hosts, block 30000-32767 yourself.
  Host-local requests reach nginx from the svclb pod address, not 127.0.0.1.
* Clients must connect to an address k3s lists in the Service status (the node's
  InternalIP/ExternalIP). For a floating or secondary IP not known to k3s, set it
  with the k3s `node-external-ip` option.
* If you put a CDN or load balancer in front, nginx sees its addresses and all
  clients behind it share a bucket. Enable real-IP handling
  (`use-forwarded-headers` plus `proxy-real-ip-cidr` restricted to that proxy's
  ranges) only for a proxy you control.

Existing installs get the Service change on the next
`sudo platformctl install ingress-nginx` (a Helm upgrade that always reconciles
these values). Check it with
`kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.externalTrafficPolicy}'`
and confirm the controller log shows public client addresses.

The controller runs as non-root
with RuntimeDefault seccomp, no privilege escalation, and only NET_BIND_SERVICE.
Requests are 100m CPU / 128Mi memory; limits are 1 CPU / 512Mi. Routing needs
configuration snippets for iframe header handling, so snippet annotations and
Critical risk remain enabled. Only trusted operators and the platform API may
write Ingress resources; do not grant tenants arbitrary Ingress write access.
HSTS excludes subdomains so application certificate bootstrap continues to work.

`platformctl provision --waf` or `platformctl install ingress-nginx --waf` enables
ModSecurity and OWASP CRS in **DetectionOnly** mode. It logs findings without
blocking requests; resources remain opt-in (limits 2 CPU / 1Gi). Reconcile an
existing controller with the install command; `harden` alone changes the host.
`PLATFORM_WAF` is saved, and `--waf=false` turns it off on a later reconciliation.
Review false positives before manually enabling blocking. See the upstream
[ModSecurity guide](https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/third-party-addons/modsecurity.md).

## Fresh Ubuntu 24.04 VM verification (for #25)

This must run on a disposable VM with console recovery, not a developer host:

1. Provision on 4 vCPU / 8 GB with an operator key. Confirm externally that only
   TCP 22/80/443 are reachable, including checking 6443, 10250, and NodePort ranges.
   `ss -tlnp` lists local listeners; an external port scan proves reachability.
2. Verify a new key login works and a password-only login is rejected. Repeat
   without any operator key and check the warning/password-preservation path.
3. Run unattended-upgrades dry-run and `chronyc tracking`. Confirm the clock is
   synced and `Automatic-Reboot` is false in `apt-config dump`.
4. Inspect `kubectl -n ingress-nginx get cm ingress-nginx-controller -o yaml`;
   exercise portal, API, Grafana, ArgoCD, Portainer, TLS, pod DNS, and outbound pod
   traffic. Verify 429 responses under deliberate rate/connection load.
5. Re-run provision and harden; test interactive rejection and timeout, automatic
   health-check failure, and reboot persistence. Confirm k3s rules survive and
   the previous owned policy is restored when confirmation fails.
6. Repeat on a clean VM with `--skip-hardening`: no platform hardening files,
   packages, jails, firewall table/service, or SSH changes should be introduced.
7. Enable `--waf`, check controller rollout and CRS detection logs, and repeat all
   UI/SSO flows. Validate the optional auth jail against exported real error logs.

Unit tests inject temp roots/runners and execute rollback shell with fake nft.
They do not validate kernel nft syntax, service ordering, remote connectivity,
nginx chart rendering, or VM reboot behavior; those checks require this VM run.
