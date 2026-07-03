# `apt` hangs at "Waiting for cache lock" during bootstrap

## Symptom

Phase 0 of the bootstrap prints:

```
E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 12345 (unattended-upgr)
E: Unable to acquire the dpkg frontend lock
```

Or the run just hangs on `apt-get install` for several minutes with no output.

## Root Cause

Every fresh Ubuntu cloud image ships with `unattended-upgrades` enabled. On first
boot it runs a full package refresh and takes a shared `dpkg` lock. Any other
`apt` command blocks until it finishes — which on a slow VM can be 5-10 minutes.

The bootstrap's pre-flight step waits up to 5 minutes for the lock to release,
but if the upgrade is still going after that, the script aborts.

## Fix

### Option 1 — wait it out

```bash
# Watch what unattended-upgrades is doing
sudo journalctl -fu unattended-upgrades
# When it finishes ("Terminating started"), re-run:
sudo ./platform-bootstrap/bootstrap.sh
```

### Option 2 — stop unattended-upgrades and take back the lock

```bash
sudo systemctl stop unattended-upgrades
sudo killall -q -w unattended-upgr apt apt-get dpkg 2>/dev/null || true

# Sanity: no lock holder now
sudo fuser -v /var/lib/dpkg/lock-frontend || echo "lock clear"

sudo ./platform-bootstrap/bootstrap.sh
```

### Option 3 — disable it permanently on this server

For a dedicated Platform host you usually don't want `unattended-upgrades`
racing with the bootstrap on every reboot:

```bash
sudo systemctl disable --now unattended-upgrades
sudo apt purge -y unattended-upgrades
```

## Verification

```bash
sudo fuser -v /var/lib/dpkg/lock-frontend
```

Empty output means the lock is free. The bootstrap will now proceed.
