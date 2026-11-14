# Secure the server

This page explains how the installer locks down the server Cairn runs on, and how to change or re-apply it. Everything here is done on the server with `platformctl`; there is nothing to set in the portal.

## What the installer does by default

`sudo platformctl provision` secures an Ubuntu server unless you opt out:

- **Firewall.** Only SSH (port 22) and web traffic (ports 80 and 443) are open to the internet.
- **SSH.** Password sign-in is turned off, but only if you already have an SSH key set up. Root can sign in with a key only.
- **Brute-force protection.** Five failed SSH sign-ins in ten minutes block that address for one hour.
- **Security updates.** Ubuntu installs security updates every day. The server never reboots by itself.
- **Clock sync.** The clock is kept accurate, which two-factor codes and HTTPS need.
- **Request limits.** Each visitor address is limited to 1,000 requests per second. Extra requests get status 429.

## Check the state

```bash
sudo platformctl status
```

It shows whether hardening is done, whether SSH still accepts passwords, whether a firewall change waits for confirmation, and whether Ubuntu asks for a reboot.

If a reboot is needed, schedule one yourself.

## Turn password SSH off

Password sign-in stays on until there is a usable key, so you are never locked out.

1. Add your public key to `~/.ssh/authorized_keys` for root or for the user you run `sudo` from.
2. Re-apply hardening:

   ```bash
   sudo platformctl harden --auto
   ```

## Re-apply after a change

Run the same command any time. It repairs drift and leaves unchanged files alone:

```bash
sudo platformctl harden --auto
```

Without `--auto` you must open a **new** SSH session, check the portal from outside, and type `confirm` within 90 seconds. If you do not, the previous firewall rules come back.

> [!WARNING]
> Keep console access to the server (for example your cloud provider's web console) during the first install. Local checks cannot prove the server is reachable from outside.

## Skip hardening

If another tool manages server security, install with:

```bash
sudo platformctl provision --skip-hardening
```

or set `PLATFORM_HARDEN=false`. The choice is saved in `/etc/platform/.env`. Skipping does not undo hardening that was already applied. Request limits on web traffic stay on either way.

To turn hardening back on later, set `PLATFORM_HARDEN=true` and run `sudo platformctl harden --auto`.

## Change the request limits

```bash
sudo INGRESS_IP_RATE_LIMIT=5000 INGRESS_IP_BURST=10000 INGRESS_IP_CONNECTIONS=4000 platformctl install ingress-nginx
```

The new values are saved for later runs. Set a value to `0` to turn that limit off.

## How it works

Hardening needs root, systemd, apt and a healthy single-node k3s install (or the high-availability profile with `PLATFORM_CLUSTER_NODES`). There is no automatic distribution upgrade and no automatic reboot. `platformctl status` reports the last applied state; it is not a continuous compliance check.

### Updates

Security-only unattended upgrades, including Ubuntu ESM security pockets where they apply, are configured in `99-platform-security`. Daily apt timers are on and automatic reboot is off. Test with `sudo unattended-upgrades --dry-run --debug`.

### SSH

- Settings are in `/etc/ssh/sshd_config.d/60-platform.conf`.
- Password and keyboard-interactive sign-in are turned off only when root's or `SUDO_USER`'s standard `authorized_keys` holds an unrestricted key that parses. Keys or `~/.ssh` folders writable by group or others do not count. Keys with forced commands or restrictions do not count. With no usable key you get a warning and sign-in stays as it was.
- Root uses `PermitRootLogin prohibit-password`.
- `sshd -t` and the effective `sshd -T` settings must pass before SSH reloads. If they fail, the previous file is restored (or the new one removed).
- If earlier cloud-init or SSH settings override this policy, platformctl stops with an error. It does not rewrite vendor files. Custom key locations or multi-factor `AuthenticationMethods` need SSH managed by you.

### Brute-force protection

fail2ban's `sshd` jail reads the journal and bans with nftables: `maxretry = 5`, `findtime = 10m`, `bantime = 1h`.

`--nginx-auth-jail` (or `PLATFORM_NGINX_AUTH_JAIL=true`) also turns on the `nginx-http-auth` jail against `/var/log/platform/ingress-error.log`. You must first export the ingress controller's nginx error stream, in native nginx format, to that root-owned, rotated file (for example with your log collector). Raw container logs do not work. The jail fails early if the file is missing. No log collector or host mount is added for you.

### Clock

chrony is installed and enabled. The install waits about 30 seconds for the clock to sync (`chronyc waitsync`). If it cannot sync, for example because UDP 123 is blocked, you get a warning and chrony keeps trying in the background. Check with `chronyc tracking`.

### Firewall

platformctl owns only the `inet platform_guard` nftables table. Its input and forward chains run at filter priority 10, after k3s' iptables hooks. Drops in other chains, including fail2ban, still win. It does not flush the whole ruleset, set an OUTPUT policy or replace kube-proxy or flannel rules. UFW is not touched. Any other firewall you run must be kept in line by you.

| Traffic | Policy |
| --- | --- |
| TCP 22 | Public SSH on the standard port |
| TCP 80, 443 | Public web traffic. Forwarded traffic is matched on the original destination port. |
| TCP 6443, 10250 | Only from the host itself and internal pod interfaces. On the `ha` profile also from `PLATFORM_CLUSTER_NODES`, together with TCP 2379/2380 and UDP 8472. |
| `cni0`, `flannel.*` | Trusted internal traffic, including pod and service routing |
| Established/related | Allowed, so existing SSH sessions and replies keep working |
| ICMP / ICMPv6 | Allowed, including IPv6 neighbour discovery and path MTU |
| DHCP client replies | Allowed, so the host can renew its address |
| Anything else new | Dropped, including external NodePorts and overlay traffic |

- Pod and service ranges default to k3s' standard IPv4 ranges and are read from `/etc/rancher/k3s/config.yaml` (scalar, comma-separated, inline list, block list and dual-stack forms). Rules that trust these ranges only apply on internal interfaces, so spoofed outside addresses are not trusted.
- Drop-ins under `/etc/rancher/k3s/config.yaml.d/` that set `cluster-cidr` or `service-cidr` (with or without a trailing `+`) are refused rather than guessed. Other drop-ins, such as the `ha` profile's ingress drop-in that turns off `servicelb` and adds `tls-san`, are allowed.
- Existing multi-node clusters are refused before any change, unless you use the `ha` profile with `PLATFORM_CLUSTER_NODES`. Then TCP 2379/2380/6443/10250 and UDP 8472 are also accepted from those node addresses, on every node. See [High availability](operations/ha.md). For other multi-node setups, or SSH on another port, use `--skip-hardening` and your own allowlists.
- To use `kubectl` from another machine, use an SSH tunnel. Port 6443 is not open to the internet.

**Ingress VIP on the `ha` profile.** The 80/443 rules already cover a floating ingress address: the input chain accepts 80/443 to any local address, and kube-proxy sends the VIP to the local ingress pod, which the forward chain admits by original port. When `API_VIP` is set, hardening adds `ip saddr <node-subnet> ip daddr <API_VIP> tcp dport 6443 accept`, so nodes in the same subnet can reach the floating Kubernetes API address.

**Safe apply and rollback.** Before replacing the rules, platformctl saves the current owned table, syntax-checks the new rules and arms a 120-second systemd rollback timer. A rejection or failed check restores the saved table at once. If that restore fails, the timer still fires. A pending change cannot be overwritten by another run. Only confirmed rules are saved, to `/etc/platform/firewall.nft`, and `platform-firewall.service` loads them at boot. The distribution's nftables service is not enabled, because its default flush would erase k3s rules. If a reboot clears the timer mid-change, the next run restores the saved table first, then applies again.

**When it runs.** The `harden` step runs after prerequisites and after cluster routing is ready, so a long first install cannot outlast the rollback window. Confirmation checks local TCP 22/80/443/6443, an sshd listener, and `/api/health/ready` over loopback HTTPS with the Cairn host name (the internal certificate is accepted; public DNS and proxies are bypassed). With `--auto` all checks must pass. Without it, you also confirm a new SSH login and outside portal access, then type `confirm` within 90 seconds.

## Ingress defaults and optional WAF

The ingress controller's `http-snippet` creates per-client request and connection zones. Limits apply per controller replica to all web traffic, including your apps. The defaults are high so that people behind one office or mobile network address are not blocked.

| Environment variable | Default | Allowed values |
| --- | --- | --- |
| `INGRESS_IP_RATE_LIMIT` | `1000` requests/second | `0` or `1-1000000` |
| `INGRESS_IP_BURST` | `2000` requests | `0` or `1-1000000` |
| `INGRESS_IP_CONNECTIONS` | `2000` concurrent connections | `0` or `1-65535` |

- An invalid value gives a warning and the default is used.
- `INGRESS_IP_RATE_LIMIT=0` removes the request limit and its zone. `INGRESS_IP_CONNECTIONS=0` removes the connection limit and its zone.
- `INGRESS_IP_BURST=0` removes the burst allowance (`burst` and `nodelay`) but keeps the request limit. Burst does nothing when the request limit is off.
- Settings are saved in `/etc/platform/.env`. Edit that file or pass environment variables, then run `sudo platformctl install ingress-nginx`.
- Limits use real nginx directives, not the unsupported `limit-rps` ConfigMap keys. See the upstream [ConfigMap reference](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/).

### Client addresses

Per-address limits only work when nginx sees the real client address. The controller service uses `externalTrafficPolicy: Local`, so k3s sends traffic for the node address straight to the local controller pod without rewriting the source. (With the older `Cluster` policy every request seemed to come from `10.42.0.1`, so all clients shared one limit, including the API's own sign-in and ingest limits.)

- Forwarding headers are not trusted: `use-forwarded-headers`, `compute-full-forwarded-for` and `use-proxy-protocol` are `false`. nginx sets `X-Forwarded-For` to the real peer, and the API trusts exactly one proxy hop (`trust proxy = 1`). Clients cannot fake their address.
- With `Local`, k3s ServiceLB forwards to `<node IP>:<node port>`, so node ports are allocated again. Without them, local access such as `https://127.0.0.1` (used by the readiness check) fails. The firewall only forwards connections whose original port is 80/443, so node ports stay closed from outside on hardened servers. With `--skip-hardening`, block ports 30000-32767 yourself. Local requests reach nginx from the ServiceLB pod address, not 127.0.0.1.
- Clients must connect to an address k3s lists in the service status (the node's InternalIP or ExternalIP). For a floating or extra address k3s does not know, set the k3s `node-external-ip` option.
- With a CDN or load balancer in front, nginx sees its addresses and all clients behind it share a limit. Turn on real-IP handling (`use-forwarded-headers` plus `proxy-real-ip-cidr` limited to that proxy's ranges) only for a proxy you control.

Existing installs get the service change on the next `sudo platformctl install ingress-nginx`. Check it with `kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.externalTrafficPolicy}'` and confirm the controller log shows public client addresses.

### Controller settings

The controller runs as non-root with the RuntimeDefault seccomp profile, no privilege escalation and only `NET_BIND_SERVICE`. Requests are 100m CPU / 128Mi memory; limits are 1 CPU / 512Mi. Routing needs configuration snippets for iframe header handling, so snippet annotations stay enabled (risk level Critical). Only trusted operators and the Cairn API may write Ingress objects; do not give tenants Ingress write access. HSTS excludes subdomains so app certificates can still be issued.

### Optional WAF

A WAF (web application firewall) inspects requests for common attacks. `platformctl provision --waf` or `platformctl install ingress-nginx --waf` turns on ModSecurity with the OWASP Core Rule Set in **DetectionOnly** mode: findings are logged, nothing is blocked. Its resources are opt-in (limits 2 CPU / 1Gi). Apply it to a running controller with the install command; `harden` only changes the host. `PLATFORM_WAF` is saved, and `--waf=false` turns it off on a later run. Review false positives before you turn on blocking by hand. See the upstream [ModSecurity guide](https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/third-party-addons/modsecurity.md).

## For developers: verify on a test VM

Run this on a disposable Ubuntu 24.04 VM with console access, never on your own machine:

1. Provision on 4 vCPU / 8 GB with an operator key. From outside, confirm only TCP 22/80/443 are reachable, including 6443, 10250 and the NodePort range. `ss -tlnp` lists local listeners; an external port scan proves reachability.
2. Check that a new key login works and a password-only login is refused. Repeat without any operator key and check the warning and that passwords still work.
3. Run the unattended-upgrades dry run and `chronyc tracking`. Confirm the clock is synced and `Automatic-Reboot` is false in `apt-config dump`.
4. Inspect `kubectl -n ingress-nginx get cm ingress-nginx-controller -o yaml`. Exercise portal, API, Grafana, Argo CD, Portainer, TLS, pod DNS and outbound pod traffic. Check 429 answers under deliberate load.
5. Re-run provision and harden. Test interactive rejection and timeout, a failed automatic health check and reboot persistence. Confirm k3s rules survive and the previous owned table returns when confirmation fails.
6. Repeat on a clean VM with `--skip-hardening`: no hardening files, packages, jails, firewall table or service, or SSH changes should appear.
7. Turn on `--waf`, check the controller rollout and rule-set detection logs, and repeat all sign-in flows. Test the optional auth jail against real exported error logs.

Unit tests use temporary roots and fake runners and run the rollback shell with a fake `nft`. They do not check kernel nft syntax, service ordering, remote connectivity, nginx chart rendering or reboot behaviour; those need the VM run.
