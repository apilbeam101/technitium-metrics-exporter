# Kubernetes install

Applies the manifests under [deploy/kubernetes/](../deploy/kubernetes/): a
single-replica `Deployment`, a `Service`, a `ConfigMap` for non-secret
configuration, an example `Secret` for the API token(s), and a `NetworkPolicy`
restricting egress to the DNS nodes' web service port (plus cluster DNS) and
ingress to the Prometheus pods.

## Prerequisites

- A cluster able to reach `ghcr.io` (the default), or with a self-built image
  reachable another way — pushed to your own registry, or loaded directly for
  a local cluster (kind, minikube).
- A dedicated, least-privilege Technitium API token — see
  [docs/DESIGN.md §6.4](DESIGN.md#64-least-privilege-token).

## Install

[deploy/kubernetes/deployment.yaml](../deploy/kubernetes/deployment.yaml)
already points `image:` at the maintainer's own published, multi-arch,
attested release (`ghcr.io/apilbeam101/technitium-metrics-exporter`, pinned
to a specific version rather than `:latest`) — no build or push needed
unless you want to run your own image instead. See
[docs/INSTALL_DOCKER.md](INSTALL_DOCKER.md#install)'s attestation
verification commands if you want to confirm the published image's
provenance and SBOM before deploying it.

To build and publish your own instead (adjust the tag for your registry, and
`deployment.yaml`'s `image:` to match):

```bash
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg IMAGE_VERSION=$(node -p "require('./package.json').version") \
  -t <registry>/technitium-metrics-exporter:latest .
docker push <registry>/technitium-metrics-exporter:latest
```

Create the real Secret — see the comment in
[deploy/kubernetes/secret.example.yaml](../deploy/kubernetes/secret.example.yaml)
for the `kubectl create secret` form; never apply that file as-is. Then edit
[deploy/kubernetes/configmap.yaml](../deploy/kubernetes/configmap.yaml)'s
`TECHNITIUM_TARGETS` before applying:

```bash
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
kubectl apply -f deploy/kubernetes/service.yaml
kubectl apply -f deploy/kubernetes/networkpolicy.yaml   # adjust selectors first
```

The `Deployment` uses `strategy.type: Recreate` (never two replicas — each
one would independently poll every DNS node), `automountServiceAccountToken:
false`, `runAsNonRoot`, `readOnlyRootFilesystem`, `seccompProfile:
RuntimeDefault`, all capabilities dropped, a `livenessProbe` on `/healthz`,
and a `readinessProbe` on `/readyz`.

## Prometheus scrape configuration

Plain `scrape_configs`, needing no CRD — this is the form to use unless the
Prometheus Operator is already installed in the cluster:

```yaml
scrape_configs:
  - job_name: technitium
    metrics_path: /metrics
    static_configs:
      - targets: [dns-a, dns-b]
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: technitium-metrics-exporter.<namespace>.svc:10153
```

Optional, and **only if** the Prometheus Operator's CRDs are already
installed — applying it where they are not fails outright:

```bash
kubectl apply -f deploy/kubernetes/servicemonitor.example.yaml   # adjust target names first
```

## Verify

```bash
kubectl get pods -l app.kubernetes.io/name=technitium-metrics-exporter
# READY 1/1, STATUS Running once /readyz has gone 200
```

Then, on the Prometheus targets page, confirm each configured target appears
as its **own** target, with `instance` set to the target name and `up == 1`.

Honest-health check (N6), from a pod with network access to the Service:

```bash
curl -s technitium-metrics-exporter.<namespace>.svc:10153/healthz
curl -s technitium-metrics-exporter.<namespace>.svc:10153/readyz
curl -s "technitium-metrics-exporter.<namespace>.svc:10153/metrics?target=dns-a" \
  | grep -E '^technitium_(up|zone_soa_serial|zones_visible)'
```

1. Stop the DNS node — `technitium_up` goes to 0, other targets unaffected.
2. Revoke the API token — `technitium_up` goes to 0 and
   `technitium_exporter_poll_errors_total{reason="auth"}` rises.
3. Restore both — `technitium_up` returns to 1.
