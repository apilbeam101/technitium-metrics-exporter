# Standalone install

Runs the exporter directly as a Node.js process under systemd, with no
container runtime involved.

## Prerequisites

- Node.js ≥ 24 on the host.
- A dedicated, least-privilege Technitium API token — see
  [docs/DESIGN.md §6.4](DESIGN.md#64-least-privilege-token).

## Install

Build from a full checkout — `tsc` is a dev dependency, so this step needs
the complete `npm ci`, not `--omit=dev`:

```bash
npm ci
npm run build
```

Then deploy only what the built artefact actually needs onto the target host
— the checkout itself (`src/`, `tsconfig.json`, dev dependencies) does not
need to exist there:

```bash
mkdir -p /opt/technitium-metrics-exporter
cp -r dist package.json package-lock.json /opt/technitium-metrics-exporter/
cd /opt/technitium-metrics-exporter
npm ci --omit=dev
```

Create the environment file and lock it down. The unit below reads it as
`EnvironmentFile`, which systemd itself reads as root before dropping to the
unit's `DynamicUser` identity — mode `0600` root-owned keeps it unreadable to
every other unprivileged process on the host, not to the exporter's own
(nonexistent-until-runtime) dynamic user:

```bash
cp example.env /opt/technitium-metrics-exporter/.env
chmod 600 /opt/technitium-metrics-exporter/.env
# edit .env: set TECHNITIUM_TARGETS and TECHNITIUM_API_TOKEN
```

Install and start the unit:

```bash
cp deploy/systemd/technitium-metrics-exporter.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now technitium-metrics-exporter
```

The unit uses `DynamicUser=true`, so no service account needs to be created by
hand, and `ProtectSystem=strict` plus `NoNewPrivileges=true` so the process
can neither write anywhere on the filesystem (including its own working
directory — the only writable path is its private `/tmp`) nor gain new
privileges at runtime.

Point Prometheus at it using the `scrape_configs` snippet in
[docs/INSTALL_KUBERNETES.md](INSTALL_KUBERNETES.md#prometheus-scrape-configuration)
— it isn't Kubernetes-specific, only the `__address__` replacement is.

## Verify

```bash
curl -s localhost:10053/healthz
curl -s localhost:10053/readyz                       # ready after the first poll
curl -s localhost:10053/metrics | head               # global registry only
curl -s "localhost:10053/metrics?target=dns-a" \
  | grep -E '^technitium_(up|zone_soa_serial|zones_visible)'
curl -s -o /dev/null -w '%{http_code}\n' "localhost:10053/metrics?target=nope"   # 400
```

Honest-health check (N6):

1. Stop the DNS node — `technitium_up` goes to 0, other targets unaffected.
2. Revoke the API token — `technitium_up` goes to 0 and
   `technitium_exporter_poll_errors_total{reason="auth"}` rises.
3. Restore both — `technitium_up` returns to 1.

```bash
journalctl -u technitium-metrics-exporter -f
```
