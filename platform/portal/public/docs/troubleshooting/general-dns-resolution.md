# General DNS Resolution — "lookup X on 127.0.0.53:53: i/o timeout"

## Symptom

> Intermittent errors in pods or system logs:
> `lookup registry-1.docker.io on 127.0.0.53:53: i/o timeout`
> or similar "i/o timeout" DNS lookup errors.

## Root Cause

`systemd-resolved` (listening on `127.0.0.53:53`) forwards DNS queries to the upstream DNS servers configured in `/etc/systemd/resolved.conf`. When the upstream is a private DNS resolver (e.g., k3d's built-in `coredns` at `10.43.0.10`, or the host's own DNS server), it may fail to resolve external names. This happens because:

- Private DNS servers are configured only for cluster-internal lookups.
- They are not authoritative for public domains and may not forward to public resolvers.
- `systemd-resolved` times out waiting for a response from the upstream.

## Fix

Override the DNS server to a public resolver in `systemd-resolved`.

### 1. Edit `/etc/systemd/resolved.conf`

```ini
[Resolve]
DNS=8.8.8.8
FallbackDNS=1.1.1.1 2606:4700:4700::1111
Domains=~.
```

> The `Domains=~.` line tells systemd-resolved to use the configured DNS server for **all** domains (the `~.` is a glob matching everything). This prevents it from falling back to other sources.

### 2. Symlink `/etc/resolv.conf` to `systemd-resolved`'s stub

```bash
sudo ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
```

### 3. Restart `systemd-resolved`

```bash
sudo systemctl restart systemd-resolved
```

### 4. Verify the configuration

```bash
resolvectl status
```

Look for the `DNS Servers` line — it should show `8.8.8.8`.

### 5. Test DNS resolution

```bash
resolvectl query registry-1.docker.io
dig @127.0.0.53 registry-1.docker.io
```

Both should return IP addresses without timeout.

## Verification

```bash
# Quick connectivity test
curl -s -o /dev/null -w "%{http_code}" https://registry-1.docker.io/v2/ --max-time 10
```

Expected output: `200` or `401` (authentication required — but no timeout).

```bash
# Run a pod in the cluster and test DNS
kubectl run dns-test --image=busybox --rm -it --restart=Never -- nslookup google.com
```

Expected output — the domain resolves successfully.
