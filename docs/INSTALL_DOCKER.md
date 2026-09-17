# Docker install

Runs the exporter as a container, built from the multi-stage `Dockerfile` at
the repository root.

## Prerequisites

- Docker (or a compatible OCI runtime) able to build and run Linux
  containers.
- A dedicated, least-privilege Technitium API token — see
  [docs/DESIGN.md §6.4](DESIGN.md#64-least-privilege-token).

## Install

```bash
cp example.env .env      # set TECHNITIUM_TARGETS and TECHNITIUM_API_TOKEN

docker build \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg IMAGE_VERSION=$(node -p "require('./package.json').version") \
  -t technitium-metrics-exporter .
docker run --rm --env-file .env -p 10053:10053 technitium-metrics-exporter
```

The two `--build-arg`s are optional — the image builds and runs identically
without them — but without them the `org.opencontainers.image.version` and
`.revision` OCI labels stay at their placeholder defaults rather than
matching what `technitium_exporter_build_info` reports at runtime.

Or with Compose, which also applies the container hardening (`read_only`,
`cap_drop: ALL`, `no-new-privileges`) from
[deploy/docker-compose.yml](../deploy/docker-compose.yml):

```bash
docker compose -f deploy/docker-compose.yml up --build
```

The image runs as the fixed non-root `exporter` user (UID/GID `10001`) and
declares its own `HEALTHCHECK`, so `docker ps` and Compose's
`service_healthy` condition both reflect the exporter's real `/healthz`
status rather than just "the container process is running". The
`HEALTHCHECK` connects to `127.0.0.1` regardless of `METRICS_BIND_ADDRESS`,
and to plain HTTP unless `METRICS_TLS_CERT_PATH` is set (in which case it
uses HTTPS without verifying the listener's certificate — appropriate for a
local liveness probe). It cannot authenticate against an mTLS-only listener
(`METRICS_TLS_CLIENT_CA_PATH` set): the container will report unhealthy
regardless of the exporter's real state in that configuration, so monitor
health externally instead if mTLS is required on the metrics listener.

Point Prometheus at it using the `scrape_configs` snippet in
[docs/INSTALL_KUBERNETES.md](INSTALL_KUBERNETES.md#prometheus-scrape-configuration)
— it isn't Kubernetes-specific, only the `__address__` replacement is (here,
the container's own host:port).

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
docker logs -f <container>
```
