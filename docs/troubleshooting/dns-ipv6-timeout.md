# DNS / IPv6 Timeout — "TLS handshake timeout"

## Symptom

> Helm or Docker registry operations hang with `TLS handshake timeout`.

## Root Cause

IPv6 is enabled on the server but the outbound IPv6 route is broken or unreachable. The system's DNS resolver returns an IPv6 AAAA record for the registry, the client attempts an IPv6 connection, the TCP handshake times out, and only then does it fall back to IPv4 — causing long delays or total failure if IPv4 fallback is also misconfigured.

## Fix

### 1. Configure `/etc/gai.conf` to prefer IPv4

Edit `/etc/gai.conf` and uncomment or add:

```
precedence ::ffff:0:0/96  100
```

This gives IPv4-mapped IPv6 addresses higher precedence than native IPv6.

### 2. Configure `systemd-resolved` to use a reliable DNS server

Edit `/etc/systemd/resolved.conf`:

```ini
[Resolve]
DNS=8.8.8.8
FallbackDNS=1.1.1.1
```

### 3. Restart `systemd-resolved`

```bash
sudo systemctl restart systemd-resolved
```

## Verification

```bash
# Confirm DNS is now using the configured server
resolvectl status

# Test registry connectivity without IPv6 hang
curl -v https://registry-1.docker.io/v2/ 2>&1 | grep -i "connected\|IPv6\|TLS"
```

You should see a quick TCP connection to an IPv4 address and a successful TLS handshake.
