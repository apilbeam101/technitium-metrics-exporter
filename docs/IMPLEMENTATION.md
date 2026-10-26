# Implementation Plan

How the exporter gets built: repository layout, shared primitives, and phased
delivery with exit criteria. This is a working document for contributors and is
retired at v1.0.0.

For what the exporter is and why each decision was made, see
[DESIGN.md](DESIGN.md). Section references of the form `D§3.2` point there.

Every phase ends green on:

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run check
```

Phases are ordered so that the riskiest unknowns — API envelope behaviour and
conditional zone-field presence — are settled early, and so that the core
deliverable, zone health, lands before any optional collector.

---

## Repository layout

Target state once every phase below is complete — most of this does not exist
yet. See the per-phase sections for what each phase actually adds.

```
LICENSE  README.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
CHANGELOG.md  package.json  tsconfig.json  tsconfig.test.json  biome.json
example.env

src/
  index.ts                    startup sequence
  cli.ts                      --version / --help / --dump-raw
  version.ts
  node-version-check.ts
  lifecycle.ts
  config/
    types.ts  load.ts  validate.ts  secret.ts  redact-summary.ts  deep-freeze.ts
  http/
    agent.ts  client.ts  path-allowlist.ts  retry.ts  errors.ts  clock.ts
  log/
    logger.ts  redact.ts  sanitize-url.ts  header-allowlist.ts  error-normalize.ts
  api/
    envelope.ts  schema.ts  time.ts  enums.ts
    session.ts  zones.ts  stats.ts  cluster.ts  native-text.ts
  domain/
    target.ts  snapshot.ts  session.ts  zone.ts  stats.ts  cluster.ts
  metrics/
    registry.ts  state-set.ts  absent-gauge.ts
    session-metrics.ts   session-collector.ts
    native-metrics.ts    native-collector.ts
    zone-metrics.ts      zone-collector.ts
    stats-metrics.ts     stats-collector.ts
    cluster-metrics.ts   cluster-collector.ts
  poller/
    target-registry.ts  target-poller.ts  cache.ts  refresh-cache.ts  self-metrics.ts
  server/
    server.ts  routes.ts
  dump-raw.ts

test/
  unit/  integration/  support/
  fixtures/{session,zones,stats,cluster,native,golden}/

alerts/       technitium-dns.yaml  technitium-dns.test.yaml
dashboards/   technitium-dns.json
Dockerfile
deploy/       docker-compose.yml  kubernetes/  systemd/
docs/         DESIGN.md  IMPLEMENTATION.md  METRICS.md
              INSTALL_STANDALONE.md  INSTALL_DOCKER.md  INSTALL_KUBERNETES.md
              DASHBOARDS_AND_ALERTS.md  TROUBLESHOOTING.md
              LIVE_VALIDATION.md  RELEASE_CHECKLIST.md
scripts/      generate-metrics-doc.ts  generate-dashboard.ts  sanitize-fixtures.ts
              check-pack-allowlist.ts  check-no-native-addons.ts
              check-license-compound.ts
.github/workflows/  ci.yml  release.yml  rebuild.yml  scan.yml
```

---

## Shared primitives

Built in the early phases and consumed everywhere after. Each is small, pure
where possible, and independently testable.

### `config/secret.ts`

A `Secret` wrapper whose `toString`, `toJSON` and `util.inspect` custom hook all
return a redaction placeholder. This makes N5 hold even on a log or error path
nobody anticipated, rather than depending on every call site remembering to
redact.

### `http/clock.ts`

An injectable clock: `now()`, a monotonic `elapsed()`, and `sleep()`. Every
timing behaviour is then deterministically testable and no test sleeps in real
time.

### `http/client.ts`

A `get()`-only client with a **total wall-clock budget** per logical call. Each
attempt receives an `AbortSignal.timeout` sized to the *remaining* budget, and
time spent in retry backoff is measured on the monotonic clock and deducted, so
a call cannot exceed its budget by accumulating retries.

Never follows redirects and never reads `Location`. `get()`'s own return value
(`{ statusCode, body }`) is what `--dump-raw` reads directly, one endpoint at a
time — there is no separate raw-response hook.

### `http/path-allowlist.ts`

A frozen allowlist of the exact endpoint paths in D§3.1. Any other path throws
before a request is constructed. This is the mechanism behind D§6.3 — necessary
because the upstream API accepts GET for destructive operations, so `get()`-only
is not by itself read-only.

### `api/envelope.ts`

One function classifying any response as `ok`, `invalid-token`, `api-error` or
`not-json`, used by every call site. The HTTP-200-on-auth-failure behaviour
(D§3.2.1) is then handled in exactly one place instead of being re-remembered
per collector.

### `api/time.ts`

The .NET timestamp rules from D§3.2.10: sentinel detection, explicit UTC
interpretation of suffix-less values, and tolerance of seven fractional digits.

### `metrics/state-set.ts`

Pure enum classification returning `{ kind: 'absent' | 'recognized' |
'unrecognized' }`. The caller owns the unknown-value counter, which keeps the
primitive free of metric dependencies and therefore trivially testable.

### `metrics/absent-gauge.ts`

A label-free-gauge wrapper (`set`/`clear`/`setOrClear`) that removes and
recreates the underlying `Gauge` instead of resetting it, since `reset()`
alone can only zero a label-free gauge's value and can never make its one
series disappear. Shared by every metric that must be genuinely absent until
it first has a real value and absent again once that value stops applying
(`technitium_cluster_nodes`, the native lifetime-counter gauge fields,
`technitium_zones_visible`/`technitium_zones_excluded_internal`).

### `poller/refresh-cache.ts`

The independent-cadence primitive:

```ts
createRefreshCache<T>({ clock, intervalMs, fetch, initialValue, onFailure })
  => { refreshIfDue(): Promise<boolean>, getCached(): T }
```

`refreshIfDue()` resolves to whether it actually attempted a fetch this call,
so a caller can tell a cycle that made a real attempt (and so may legitimately
count that attempt's own failure, e.g. toward
`technitium_exporter_poll_errors_total`) apart from an off-cadence cycle that's
merely restating the last attempt's outcome because the interval hasn't
elapsed yet. `getCached()` is synchronous and network-free, so a collector's
own `collect()` can call both every poll cycle — `refreshIfDue()` to throttle
the network call, `getCached()` to read whatever the last successful fetch (or
`initialValue`) produced — without a second scheduler. A failed refresh
retains the previous value and does not throw. This is how the cluster and
statistics collectors get slower cadences than the main loop.

### `poller/cache.ts`

An immutable `CacheEntry` with a monotonic `fetchedAt`, plus a parse-error
tracker so that a cycle returning zero results *because parsing failed* is not
recorded as a success.

---

## Phase 0 — Scaffold and hygiene

`package.json` (Apache-2.0, `engines.node >=24`, `files` allowlist, `bin`),
`tsconfig.json` and `tsconfig.test.json`, `biome.json`, `.gitignore`,
`.dockerignore`, `.gitattributes`, `.gitleaks.toml`, `LICENSE`, `README.md`,
`CONTRIBUTING.md` (DCO), `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`,
`example.env`, issue and PR templates, `dependabot.yml`, and a placeholder
`src/index.ts` (just enough for `tsc` to have an input and for `bin`/`main`
to point at a real, shebanged file — the real startup sequence is Phase 7).

Supply-chain guard scripts with their tests: `check-no-native-addons.ts`,
`check-pack-allowlist.ts`, `check-license-compound.ts`, aggregated behind
`npm run check` and wired into `CONTRIBUTING.md` and the PR template so they
are actually run, not just present.

Every `.dockerignore` pattern is `**/`-prefixed. Docker's exclusions, unlike
git's, only match at the context root, so an unprefixed `*.pem` leaves nested
key material in the build context.

**Exit:** test run green; `npm pack --dry-run` contains only intended files.

## Phase 1 — Fixtures and sanitisation

Hand-authored fixtures from the schemas in D§3, replaced by sanitised live
captures in Phase 14. Coverage is chosen to hit every documented hazard:

- an `invalid-token` envelope, and a `status: error` envelope carrying
  `stackTrace`
- `metrics/text` in **both** name spellings (D§3.2.2)
- a zone list spanning all seven types, internal zones, and each
  conditional-field combination (D§3.2.7) — `internal` present only on the
  server's own system zones, never as `false` on an ordinary zone
- a `session/get` with `clusterInitialized: true` and an embedded peer
  inventory: the node's own entry (no `lastSeen`), a connected peer (an
  ordinary `lastSeen`), and enough peers to cover all four `state` values
  (D§3.2.9)
- an `admin/cluster/state` response with a never-sentinel `lastSeen` and an
  `Unknown` state
- a `protocolTypeChartData` with a single label (D§3.2.8)
- a pre-v15.0 `session/get`

`scripts/sanitize-fixtures.ts`, plus tests asserting no routable IP address,
real domain, or token-shaped string appears in any fixture, and that fixture
shapes match what the parsers expect.

**Exit:** the sanitisation guard fails on a deliberately planted bad fixture.

## Phase 2 — Configuration and targets

`config/types.ts` (`TargetConfig`, `AppConfig`), `load.ts` (`--env-file`, with
process environment taking precedence), `validate.ts`, `secret.ts`,
`redact-summary.ts`, `deep-freeze.ts`.

Target-name parsing, `__<NAME>` override resolution, and the orphan-override
startup error (D§6.1).

**Exit:** tests for every validation rule, for duplicate and malformed target
names, and for the orphan override; plus a test proving no configuration
summary or thrown error can contain a token.

## Phase 3 — HTTP layer, envelope, path allowlist

`http/agent.ts`, `client.ts`, `retry.ts`, `errors.ts`, `clock.ts`,
`path-allowlist.ts`; `api/envelope.ts`, `api/time.ts`. Error taxonomy including
`api_error`.

**Exit:** tests prove that a 200 carrying `invalid-token` classifies as an auth
failure; that a destructive path throws; that the never-sentinel maps to
"never"; that a suffix-less timestamp is read as UTC regardless of the machine's
`TZ`; and that the wall-clock budget is respected across retries.

## Phase 4 — Session collector, permission gating, honest `up`

`api/session.ts`, `metrics/session-metrics.ts`, `session-collector.ts`.

Per-target startup preflight recording version, node identity,
cluster-initialised flag, and permission map. For each **enabled** collector
whose permission is absent: one loud warning, mark it skipped, and set
`technitium_collector_success{collector} 0` — never retry-and-error every cycle.

The version and node-identity fields this preflight already parses are
exported directly as `technitium_server_version_info`,
`technitium_server_version_supported`, and `technitium_server_domain_info`
(D§5.1) — no separate collector or call needed.

`session/get`'s own response also carries the cluster peer inventory whenever
`clusterInitialized` is true (D§3.2.9), with no extra permission or call
needed. This phase therefore also owns `technitium_cluster_node_state`,
`technitium_cluster_node_last_seen_timestamp_seconds` and
`technitium_cluster_nodes` (D§5.6) — the peer address and URL fields in that
same inventory are parsed and then discarded, never exported (D§4.2). The
remaining cluster metrics (heartbeat/refresh intervals, config sync time) stay
with the `Administration: View`-gated collector in Phase 8.

`technitium_up` derives from the actual call outcome.

**Exit:** tests prove `technitium_up` is 0 for an unreachable target, 0 for a
rejected token, and 1 only on real success (N6); a clustered fixture produces
the four-value peer state set including `Unknown`, a peer removed between
renders disappears from it, and a non-clustered fixture produces none of the
three peer metrics.

## Phase 5 — Native counter normalisation

`api/native-text.ts`: a parser for this endpoint's grammar only — `# HELP`,
`# TYPE`, `name value`, with no labels, timestamps or exemplars — plus
leading-`{` detection routing an error body to the envelope handler. No valid
Prometheus exposition line can begin with `{` (this endpoint emits no labels
at all, D§3.2.2), so the body's own shape is a sufficient signal on its own;
the HTTP response's Content-Type header isn't used, since `http/client.ts`'s
`RawResponse` doesn't carry response headers and the body-shape check alone
is already exhaustive per D§3.2.1's documented dual-format behaviour.

Dual-spelling name map, millisecond conversion, unknown-metric counter,
`technitium_lifetime_counters_supported`. A metric name missing from an
otherwise well-formed response is not a parse failure — each of the thirteen
fields is independently absent-or-present, so one upstream rename shows up as
an incremented unknown-metric counter and one absent series, not as a parse
error that discards the unknown name and freezes or zeroes every unrelated
counter too.

**Exit:** golden-file tests show both spellings producing byte-identical output;
an unknown name increments the counter without breaking the render, and the
renamed field's own series goes absent rather than erroring the whole cycle; a
JSON error body produces no phantom counters — every one of the thirteen
fields is genuinely absent, not present-and-zero.

## Phase 6 — Zone collector

The core deliverable: R1 through R4.

`api/zones.ts`, `domain/zone.ts`, `metrics/zone-metrics.ts`,
`zone-collector.ts`. Also extracts `metrics/absent-gauge.ts` out of
`native-metrics.ts` and `session-metrics.ts`'s own copies of the same
label-free-gauge wrapper, once zone-metrics.ts needed a third.

Which conditional metrics exist at all is decided once, at the parse boundary
(`api/zones.ts`): each conditional field is carried through as `undefined` or
a real value exactly as the upstream response reports it per zone family
(D§3.2.7), and the metrics layer gates purely on that presence rather than
re-deriving zone-family membership itself. `domain/zone.ts`'s
`isSecondaryFamily`/`isPrimaryFamily` classifiers document which types belong
to which family and are exercised directly against the fixture, but are not
consulted by the render path. Internal-zone filter keyed on `internal ===
true` — the field is absent, not `false`, on every ordinary zone (D§3.2.7) —
with an exported excluded count. State-set rendering for `dnssecStatus`.
`notifyFailedFor` reduced to a count. The parser tolerates and ignores fields
outside this design's metric surface (e.g. `catalog`) rather than failing on
them.

**Exit:** tests for all seven zone types; conditional fields absent rather than
zero; a zone removed between two renders disappears from the output;
`technitium_zones_by_type` sums to `technitium_zones_visible`.

## Phase 7 — Multi-target poller, per-target registries, HTTP server

`poller/target-registry.ts`, `target-poller.ts`, `cache.ts`,
`refresh-cache.ts`; `server/server.ts`, `routes.ts`.

A self-scheduling loop driven by the injected clock, so cycles structurally
cannot overlap, with per-target startup jitter.

Routes: `/metrics` (global), `/metrics?target=` (per target, single-flighted so
concurrent scrapes share one render), `/healthz`, `/readyz`, `/`, and 404/405
with an `Allow` header.

Server hardening: bounded `headersTimeout`, `requestTimeout`,
`keepAliveTimeout`, `maxHeaderSize` and `maxConnections`; optional TLS and mTLS
on the listener; a hardening snapshot logged at startup.

Startup order:

1. Node version check
2. configuration
3. logger
4. build info
5. **server listen**
6. poller construct, signal handlers install
7. preflight
8. poller start

The listener and the signal handlers must both precede any upstream call, so
that `/healthz` answers immediately and a `SIGTERM` arriving during a slow
preflight still runs the graceful path.

**Exit:** integration tests — concurrent scrapes of two targets are independent;
one target hard-down leaves the other's series intact with `up = 1`; graceful
shutdown completes; bare `/metrics` returns only global series; an unknown
target returns 400.

## Phase 8 — Cluster configuration-detail collector

Opt-in, `Administration: View`-gated. The peer state set itself
(`technitium_cluster_node_state` and its neighbours) is already produced by
Phase 4 from `session/get`, with no permission — this phase adds only the
four metrics that call doesn't carry: heartbeat/refresh intervals and config
sync time (D§5.6).

`api/cluster.ts`, `metrics/cluster-metrics.ts`, `cluster-collector.ts`.

Never-sentinel handling for `admin/cluster/state`'s own `lastSeen`; auto-skip
when `Administration: View` is absent. Runs on its own cadence via
`refresh-cache`.

**Exit:** tests for the never-sentinel and for auto-skip; a test proving that
disabling this collector does not remove the Phase-4-sourced peer state set
from the render.

## Phase 9 — Statistics window collector

R6, opt-in.

`api/stats.ts`, `metrics/stats-metrics.ts`, `stats-collector.ts`.

Index-zipped `labels[]` and `data[]` parsing; all five protocols and all five
response types always exported, zero-filled; query-type split gated off by
default; `technitium_zones_reported` for the D§5.3 cross-check.

Its own cadence with the enforced 60-second floor, and a comment at the interval
constant naming the reverse-DNS side effect as the reason the floor exists.

**Exit:** tests show a single-label `protocolTypeChartData` producing five
series; a `labels`/`data` length mismatch is a parse error rather than a
silently misaligned series; the interval floor is enforced.

## Phase 10 — Self-observability, `--dump-raw`, generated metrics doc

`poller/self-metrics.ts`; the `_series` cardinality tripwire; `dump-raw.ts`
writing sanitised JSON to stdout with all logging diverted to stderr, and hard
redaction of the echoed session token (D§3.2.11) and of `stackTrace`.

`scripts/generate-metrics-doc.ts` produces `docs/METRICS.md`, with a drift test.

**Exit:** a test proves `--dump-raw` output cannot contain a token; the
`METRICS.md` drift test is green.

## Phase 11 — Deployment artefacts

`Dockerfile`: multi-stage builder to slim runtime, production dependencies only,
fixed non-root UID/GID `10001`, OCI labels, `EXPOSE 10153`, exec-form
`ENTRYPOINT` so the process is PID 1 and receives `SIGTERM` directly, and a
`HEALTHCHECK` that honours the port and TLS settings and **sets its own request
timeout** — Docker's `--timeout` marks a check failed but does not reap the
request, leaking one process per check against a hung server.

`deploy/docker-compose.yml`, `deploy/kubernetes/*`, `deploy/systemd/*`, and the
three install guides, all as specified in D§8.

**Exit:** multi-arch build green; an image-hygiene test proves no `.env`, key
material or source file in any layer; a real container reaches `/readyz` 200
against the mock server.

## Phase 12 — Dashboard and alerts

`scripts/generate-dashboard.ts` produces `dashboards/technitium-dns.json`.
`alerts/technitium-dns.yaml` with `technitium-dns.test.yaml` covering every rule
in D§7 in both directions, plus the metric-name cross-check test.

**Exit:** `promtool check rules` and `promtool test rules` green in CI; every
rule observed both firing and not firing.

## Phase 13 — CI, release, supply chain

`ci.yml`:

- fast leg — typecheck, lint, unit tests
- matrix — Linux, macOS and Windows across Node 24 and current, running build
  **and** typecheck **and** the full suite, so a platform-specific type error is
  caught and the `dist` smoke tests actually run
- multi-arch docker build without push, plus image hygiene
- `npm audit --omit=dev --audit-level=high`
- production-dependency license allowlist with a compound-SPDX backstop
- no-native-addons check
- DCO check
- gitleaks over full history
- promtool

`release.yml`, on `v*.*.*`:

- re-verify at the tagged commit, and assert the tag matches `package.json`
- build and push multi-arch to GHCR with build provenance and an attested SPDX
  SBOM
- mirror the already-built manifest to Docker Hub with
  `docker buildx imagetools create`, under `continue-on-error: true`, so a
  mirror outage can never fail a release
- optional `npm publish --provenance` behind a repository variable
- a GitHub Release whose notes come from the matching `CHANGELOG.md` section,
  failing if no such section exists — which makes promoting `[Unreleased]` a
  real gate rather than a convention

`rebuild.yml` for a monthly base-image rebuild; `scan.yml` for a monthly
vulnerability scan to SARIF. All actions SHA-pinned. `promtool` fetched from its
official release and sha256-verified.

Resolve the port allocation (D§9.1) before the first tag.

The first tag against this repository itself is deferred until Phase 14
completes: a technically correct release pipeline is not the same claim as an
exporter validated against a real Technitium server, and v0.1.0 should mean
both. This phase's own exit bar is the dry run below, exercised on a fork —
not a tag on this repository.

**Exit:** a dry-run tag on a fork produces an attested multi-arch image on
GHCR — build provenance for the manifest as a whole plus a per-architecture
SPDX SBOM, each independently verifiable with `gh attestation verify` —
mirrored to Docker Hub without those GitHub-native attestations, since
`docker buildx imagetools create` copies the manifest and its layers but not
the separate OCI referrer manifests they're pushed as, and a release with
real notes.

## Phase 14 — Live validation and fixture replacement

Against real servers: capture `--dump-raw` from a primary, a secondary, a
cluster member, and a non-clustered standalone. Replace the Phase 1
hand-authored fixtures with sanitised real captures and reconcile every
difference — the metric shape must be driven by real payloads, not by the field
lists in this plan.

Walk the least-privilege token procedure (D§6.4) exactly as written, including
deliberately withholding `View` on one zone to confirm
`TechnitiumZoneVisibilityMismatch` fires. Run this with `ZONES_INCLUDE_INTERNAL=true`
— at the default `false`, the rule fires regardless of the withheld permission,
which would make the test meaningless.

Done, in two stages: a coarser variant first (revoking the entire `Zones: View`
section grant), which triggers this exporter's own permission gate and skips
the zones collector entirely — `technitium_zones_visible` goes genuinely
absent rather than becoming a smaller present number, and `!=` against a
missing series doesn't fire in Prometheus — followed by D§6.4's exact
per-zone scenario (`View` withheld on specific zones, the section grant left
intact), which produced a real, present, smaller `technitium_zones_visible`
and confirmed the alert's condition genuinely holds against real data.
Separately, this pass found a real, permission-independent gap between these
two metrics on any clustered node (see D§5.3) and the alert now excludes
clustered instances accordingly.

Confirm that a deliberately stalled zone transfer produces a firing
`TechnitiumZoneTransferStale` before the zone expires. **Skipped** — out of
scope for this validation pass; the alert's crafted-data `promtool` coverage
stands in for it. See `LIVE_VALIDATION.md`.

Confirm whether `admin/cluster/state`'s `configLastSynced` field can ever
carry D§3.2.10's never-sentinel against a real cluster member, and update
D§5.6 once known either way (D§9.3). Partially done: a live capture confirmed
the field can be genuinely absent even on an actively clustered, actively
heartbeating node; no capture has yet shown it present at all, so whether it
can carry the sentinel stays open.

Zone-list pagination behaviour at scale (D§9, open question 2) — **skipped**,
also out of scope for this pass; both real targets available had far too few
zones to exercise it.

Recorded in [`docs/LIVE_VALIDATION.md`](LIVE_VALIDATION.md), including which
fixtures were reconciled against real captures and which stayed
hand-authored because neither real target could produce the scenario without
changing production configuration.

**Exit:** every fixture is a sanitised real capture; every shipped alert has
been observed firing at least once against real or crafted data. Met in a
deliberately scoped sense — see `LIVE_VALIDATION.md` for exactly what stayed
hand-authored and why the crafted-data `promtool` suite already satisfies the
alert-firing half of this bar on its own.

Once this bar is met, promote `CHANGELOG.md`'s `[Unreleased]` section to
`[0.1.0]` and push the first real tag against this repository (Phase 13's
deferred exit condition).

---

## Testing strategy

**Unit.** Every module under `node:test`. Pure parse, map and render functions
against fixtures. Redaction tested in both directions: the placeholder appears,
and the secret does not.

**Golden files.** The full `/metrics` exposition per scenario, compared byte for
byte. This is what turns an accidental metric rename, an added label, or a
reordering into a failing test rather than a silent breaking change for every
downstream dashboard.

**Integration.** A mock Technitium server in `test/support/` serving the
fixtures, exercising: a full poll cycle; concurrent multi-target scrapes;
per-target failure isolation; series disappearance; the
HTTP-200-error-envelope path; auth failure; stale cache; graceful shutdown; TLS
and mTLS on the metrics listener; a `dist/` smoke test in a real subprocess;
docker image hygiene; and a soak run to catch a leak in the per-target registry
path.

**Not in CI.** Anything needing a real Technitium server. That is Phase 14.

---

## Verification

```bash
npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run check

cp example.env .env      # set TECHNITIUM_TARGETS and TECHNITIUM_API_TOKEN
node dist/index.js

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

Diagnostics, alerts and container:

```bash
node dist/index.js --dump-raw > ./raw.json           # chmod 600; review before sharing, then delete

promtool check rules alerts/technitium-dns.yaml
promtool test rules alerts/technitium-dns.test.yaml

docker build -t technitium-metrics-exporter .
docker run --rm --env-file .env -p 10153:10153 technitium-metrics-exporter
```

Kubernetes: apply `deploy/kubernetes/`, confirm the pod reaches Ready, then
confirm on the Prometheus targets page that each configured target appears as
its **own** target, with `instance` set to the target name and `up == 1`.
