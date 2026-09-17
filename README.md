# technitium-metrics-exporter

A [Prometheus](https://prometheus.io/) exporter for [Technitium DNS
Server](https://technitium.com/dns/), focused on zone-level health that
Technitium's own native metrics endpoint cannot express: SOA serial
divergence between nodes serving the same zone, and secondary zone transfer
failure.

**Status:** pre-release. See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)
for current progress.

## Why

Technitium's native `/api/dashboard/metrics/text` endpoint exposes only
unlabelled, server-wide scalars — there is no dimension for zone, protocol,
or cluster peer. A node whose zone transfers have stalled keeps serving stale
answers with a perfectly healthy query-success ratio right up until the zone
expires. This exporter polls the full Technitium HTTP API and turns that into
a labelled Prometheus metric surface, with one honest health signal per DNS
node.

See [docs/DESIGN.md](docs/DESIGN.md) for the full requirements, the upstream
API behaviour the design accounts for, and the complete metric surface.

## Quick start

```bash
npm ci
npm run build

cp example.env .env      # set TECHNITIUM_TARGETS and TECHNITIUM_API_TOKEN
node dist/index.js
```

```bash
curl -s localhost:10053/healthz
curl -s "localhost:10053/metrics?target=<name>"
```

Full install instructions:

- [docs/INSTALL_STANDALONE.md](docs/INSTALL_STANDALONE.md)
- [docs/INSTALL_DOCKER.md](docs/INSTALL_DOCKER.md)
- [docs/INSTALL_KUBERNETES.md](docs/INSTALL_KUBERNETES.md)

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — what the exporter exposes and why
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — how it's being built
- [docs/METRICS.md](docs/METRICS.md) — generated metric reference
- [SECURITY.md](SECURITY.md) — vulnerability reporting and the least-privilege
  token setup
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute

## License

[Apache-2.0](LICENSE)
