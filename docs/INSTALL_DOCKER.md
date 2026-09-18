# Docker install

Runs the exporter as a container, either the maintainer's own published
image or one built from the multi-stage `Dockerfile` at the repository root.

## Prerequisites

- Docker (or a compatible OCI runtime) able to run Linux containers, and
  able to build them too if building from source instead of pulling the
  published image.
- A dedicated, least-privilege Technitium API token — see
  [docs/DESIGN.md §6.4](DESIGN.md#64-least-privilege-token).

## Install

Pull the maintainer's own published image — every tagged release publishes a
multi-arch (`linux/amd64`, `linux/arm64`) image to both registries below,
with a GitHub build-provenance attestation covering the whole image and a
per-architecture SPDX SBOM attestation covering each:

```bash
docker pull ghcr.io/apilbeam101/technitium-metrics-exporter:0.1.0
# or: docker pull docker.io/apilbeam101/technitium-metrics-exporter:0.1.0
# :latest also exists on both, tracking the newest non-prerelease tag

# Provenance is attested against the multi-arch manifest as a whole, so the
# tag reference itself is enough:
gh attestation verify oci://ghcr.io/apilbeam101/technitium-metrics-exporter:0.1.0 \
  --owner apilbeam101 --predicate-type https://slsa.dev/provenance/v1

# The SBOM is attested per architecture, not against the multi-arch manifest
# — `docker inspect`'s RepoDigests is the manifest-list digest again (the
# same one the provenance check above used), not your platform's child
# manifest, so pick that out of the index directly instead:
arch=$(docker version --format '{{.Server.Arch}}')
digest=$(docker buildx imagetools inspect \
  ghcr.io/apilbeam101/technitium-metrics-exporter:0.1.0 --raw \
  | jq -r --arg a "$arch" \
    '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a) | .digest')
gh attestation verify "oci://ghcr.io/apilbeam101/technitium-metrics-exporter@${digest}" \
  --owner apilbeam101 --predicate-type https://spdx.dev/Document
```

```bash
cp example.env .env      # set TECHNITIUM_TARGETS and TECHNITIUM_API_TOKEN
docker run --rm --env-file .env -p 10153:10153 \
  ghcr.io/apilbeam101/technitium-metrics-exporter:0.1.0
```

Or with Compose, which also applies the container hardening (`read_only`,
`cap_drop: ALL`, `no-new-privileges`) from
[deploy/docker-compose.yml](../deploy/docker-compose.yml), and already points
at this same published, pinned image:

```bash
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up
```

Or build it yourself instead of pulling the published image — the image
builds and runs identically either way:

```bash
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg IMAGE_VERSION=$(node -p "require('./package.json').version") \
  -t technitium-metrics-exporter .
docker run --rm --env-file .env -p 10153:10153 technitium-metrics-exporter
```

The two `--build-arg`s are optional, but without them the
`org.opencontainers.image.version` and `.revision` OCI labels stay at their
placeholder defaults rather than matching what `technitium_exporter_build_info`
reports at runtime. To use Compose with a self-built image instead, replace
`deploy/docker-compose.yml`'s `image:` with `build: ..` (and drop the pull
step above in favour of `docker compose up --build`).

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
curl -s localhost:10153/healthz
curl -s localhost:10153/readyz                       # ready after the first poll
curl -s localhost:10153/metrics | head               # global registry only
curl -s "localhost:10153/metrics?target=dns-a" \
  | grep -E '^technitium_(up|zone_soa_serial|zones_visible)'
curl -s -o /dev/null -w '%{http_code}\n' "localhost:10153/metrics?target=nope"   # 400
```

Honest-health check (N6):

1. Stop the DNS node — `technitium_up` goes to 0, other targets unaffected.
2. Revoke the API token — `technitium_up` goes to 0 and
   `technitium_exporter_poll_errors_total{reason="auth"}` rises.
3. Restore both — `technitium_up` returns to 1.

```bash
docker logs -f <container>
```
