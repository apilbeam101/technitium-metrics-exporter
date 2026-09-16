# Design

A Prometheus exporter for [Technitium DNS Server](https://technitium.com/dns/).

This document describes what the exporter is, what it exposes, and why each
decision was made. It is the reference for reviewers and for anyone deciding
whether the exporter fits their deployment. For how it gets built, see
[IMPLEMENTATION.md](IMPLEMENTATION.md). A generated metric reference,
`METRICS.md`, will exist from the phase that adds it (see
[IMPLEMENTATION.md](IMPLEMENTATION.md) Phase 10) — it is not yet present.

---

## 1. Context

Technitium DNS Server v15.0 exposes a native Prometheus endpoint,
`GET /api/dashboard/metrics/text`. Every metric it returns is a single
server-wide scalar with **no labels**. There is no dimension for zone, protocol
or cluster peer, so per-zone and per-peer state is inexpressible by
construction rather than merely absent. The names are also unprefixed — a bare
`queries_total` in a shared Prometheus is a namespace collision waiting to
happen.

The failure modes that matter most in a multi-node authoritative DNS deployment
are zone-level, and are therefore invisible to it:

- **SOA serial divergence between nodes serving the same zone** — requires
  `soaSerial` per zone, per node.
- **A secondary zone ageing towards its SOA `expire` with no successful
  transfer** — requires `expiry`, `isExpired`, `syncFailed` and `notifyFailed`
  per zone.

A node whose zone transfers have stalled keeps serving stale answers with a
healthy `queries_total` and a 100% `no_error_total` ratio, right up to the
moment the zone expires and it begins returning SERVFAIL. Making that visible
*before* it happens is the purpose of this exporter.

**Intended outcome.** A standalone exporter that turns the Technitium HTTP API
into a labelled Prometheus metric surface — zone health, cluster peer state,
and normalised lifetime counters — with one honest health signal per DNS node,
and with standalone, Docker and Kubernetes deployment paths.

---

## 2. Requirements

### Functional

| | Requirement |
|---|---|
| **R1** | Export per-zone SOA serial, labelled by zone, so serial divergence across nodes is a single PromQL query. |
| **R2** | Export per-zone secondary transfer health: expiry timestamp, expired flag, sync-failed flag. |
| **R3** | Export per-zone primary notify health. |
| **R4** | Export per-zone DNSSEC status and disabled state. |
| **R5** | Export the server's lifetime query counters as true Prometheus counters, under a stable prefixed name, with time in seconds. |
| **R6** | Export the per-transport-protocol (UDP, TCP, DoT, DoH, DoQ) and per-response-type query split, correctly typed. |
| **R7** | Export cluster peer state as a state set. |
| **R8** | Expose **one Prometheus scrape target per DNS node**, so per-node identity comes from Prometheus's own `instance` label. |
| **R9** | Expose a per-node health signal derived from actual API outcomes. |
| **R10** | Support IPv4 and IPv6 targets, and TLS-fronted web services using a private CA. |

### Non-functional

| | Requirement |
|---|---|
| **N1** | Read-only against the DNS server. Not by convention — a write must be unrepresentable in the code. |
| **N2** | A Prometheus scrape must never trigger an upstream API call. |
| **N3** | A failure or slow response from one target must not affect another. |
| **N4** | Least-privilege authentication: a scoped API token. Never a password, never an admin account. |
| **N5** | No secret may appear in logs, errors, metrics, configuration summaries or diagnostic dumps. |
| **N6** | Health signals must be honest. A metric indicating success must be derived from an actual success; no code path assigns one a constant. |
| **N7** | Bounded label cardinality, with a tripwire metric that makes growth visible. |
| **N8** | Metric names are stable within a major version, independent of upstream naming changes. |

---

## 3. Upstream API behaviour this design is built on

The behaviours below are current as of server version 15.4.0 (2026-09-14).

### 3.1 Endpoints used

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/user/session/get` | **none** | Version, node identity, cluster flag, cluster peer inventory when clustered, and the token's own permission map |
| `GET /api/dashboard/metrics/text` | `Dashboard: View` | Lifetime counters |
| `GET /api/zones/list` | `Zones: View` **and per-zone `View`** | Zone health |
| `GET /api/dashboard/stats/get` | `Dashboard: View` | Protocol and response-type split; live cache and blocklist gauges |
| `GET /api/admin/cluster/state` | `Administration: View` | Cluster configuration detail — heartbeat and refresh intervals, config sync time |

Authentication is `Authorization: Bearer <token>`. The legacy `token` query
parameter is an explicit non-goal: it places the credential into URLs, access
logs and error pages.

### 3.2 Behaviours that shape the design

1. **The API returns HTTP 200 on authentication failure**, with
   `{"status":"invalid-token"}` in the body. Status codes cannot be trusted, so
   the JSON envelope is parsed on every response. `metrics/text` is
   dual-format: Prometheus text on success, JSON on error.

2. **The native metric names are not stable.** Some published references to
   this endpoint still show `total_queries` and `total_no_error`; current
   deployments emit `queries_total` and `no_error_total` instead. The
   endpoint is documented as *"experimental and may change in later
   releases."* Both spellings are accepted and mapped to one stable exported
   name (R5, N8).

3. **`start_time` is in milliseconds**, against the Prometheus seconds
   convention, and only two of the thirteen native metrics carry `# HELP`.

4. **`/api/zones/list` is filtered per zone.** A token lacking `View` on a
   zone receives a response that silently omits it — indistinguishable from the
   zone having been deleted. Addressed in [§5.3](#53-detecting-a-token-that-cannot-see-every-zone).

5. **The API accepts GET for destructive operations.** Endpoints such as
   `/api/zones/delete` are reachable by GET. A GET-only client is therefore not
   sufficient for N1: the request **path** is what must be constrained
   ([§6.3](#63-read-only-enforcement)).

6. **`/api/dashboard/stats/get` has a side effect.** It resolves reverse DNS
   for its top-clients list on every call, whether or not the caller wants that
   data. This collector therefore runs on its own much slower cadence, with an
   enforced minimum interval.

7. **Field presence in `/api/zones/list` is conditional, and the field set is
   larger than the metric surface uses.** `expiry`, `isExpired` and
   `syncFailed` appear only on secondary-family zones; `notifyFailed` and
   `notifyFailedFor` only on primary-family, non-internal zones; `internal` is
   present, and only ever `true`, on the server's own built-in system zones,
   and otherwise absent — it is never reported as `false`. A zone that belongs
   to a catalog also carries a `catalog` field naming that catalog
   ([§4.2](#42-scope)). These conditional fields are exported as absent
   series, never as zero; fields outside this design's stated metric surface
   are read and ignored rather than treated as a parse failure.

8. **Chart data is positional and sparse.** `labels[]` and
   `datasets[0].data[]` are parallel arrays, zipped by index. A protocol with
   zero traffic is **omitted from `labels` entirely** rather than reported as
   zero, and `queryTypeChartData` is trimmed to the top ten by default.

9. **`/api/user/session/get` returns a full cluster peer inventory, with no
   permission requirement, the moment the target node has clustering
   initialised.** `clusterInitialized: true` is accompanied by a peer list,
   each entry carrying identity (`name`), role (`type`), connection state
   (`state`), a `lastSeen` timestamp, and a network address and URL. Because
   this call needs no grant and already runs every cycle to establish
   `technitium_up`, peer identity, role and connection state are available
   whether or not the separately-gated cluster collector is even enabled —
   see [§5.6](#56-cluster). The address and URL fields arrive the same way,
   unasked for, and are read and discarded rather than exported (also
   [§5.6](#56-cluster)). This peer-list `lastSeen` is absent for the node's
   own entry and, when present for a peer, is an ordinary timestamp; it is a
   distinct field from the `lastSeen` in point 10 below, which belongs to the
   separate cluster configuration call.

10. **.NET timestamp hazards.** `expiry` and `lastModified` are ISO 8601 with
    seven fractional digits. `/api/admin/cluster/state`'s own `lastSeen` uses
    `"0001-01-01T00:00:00"` as a "never" sentinel, **with no `Z` suffix**, so a
    naive parse reads it as local time. Sentinels map to an absent series;
    suffix-less timestamps are explicitly interpreted as UTC.

11. **`/api/user/session/get` echoes the bearer token** back in its own
    response body. It is redacted everywhere (N5).

12. **`{"status":"error"}` responses carry `stackTrace`.** Only `errorMessage`
    is logged at info level or above.

13. **`/api/settings/get` returns secrets in plaintext** — TSIG shared secrets
    and TLS certificate passwords. Out of scope ([§4.2](#42-scope)).

14. **The success envelope's shape is not uniform across endpoints.**
    `/api/zones/list`, `/api/dashboard/stats/get` and `/api/admin/cluster/state`
    all wrap their payload under a `response` key alongside the top-level
    `status`/`server` fields. `/api/user/session/get`'s own envelope is flat
    instead: `info`, `permissions` and the echoed token (point 11 above) sit
    directly alongside `status`/`server`, with no `response` wrapper. Each
    endpoint's parser is therefore told which shape to expect rather than the
    envelope layer inferring it — inferring "no `response` key" as "this
    endpoint is flat" would silently reclassify a wrapped endpoint that lost
    its `response` key (an upstream regression) as a valid flat response
    instead of a parse failure.

### 3.3 Bounded enumerations

| Set | Values |
|---|---|
| Zone `type` | `Primary`, `Secondary`, `Stub`, `Forwarder`, `SecondaryForwarder`, `Catalog`, `SecondaryCatalog` |
| Zone `dnssecStatus` | `Unsigned`, `SignedWithNSEC`, `SignedWithNSEC3` |
| Cluster peer `state` | `Unknown`, `Self`, `Connected`, `Unreachable` |
| Cluster peer `type` | `Primary`, `Secondary` |
| Transport protocol | `Udp`, `Tcp`, `Tls`, `Https`, `Quic` |
| Response type | `Authoritative`, `Recursive`, `Cached`, `Blocked`, `Dropped` |

Each is exported as a **state set** — one series per possible value, exactly one
set to `1` — and never as a single gauge holding a numeric code. A conflated
enum gauge cannot distinguish an unrecognised value from a specific known one,
and leaves a stale number behind when a value stops being reported.
Unrecognised values increment a counter and are otherwise dropped.

### 3.4 Minimum supported server version

**v15.0.0.** Bearer authentication and both metrics endpoints were introduced
there. `info.version` is checked at startup per target. A lower version logs an
error and sets `technitium_server_version_supported 0` for that target rather
than exiting — one legacy node must not stop the exporter serving the others.

---

## 4. Architecture

### 4.1 Poll, cache, serve

A background poll loop per target writes an immutable snapshot to an in-memory
cache. `/metrics?target=<name>` renders from that snapshot (N2).

This is enforced structurally rather than by discipline: no object in the
HTTP-server layer is given an API client, so no render path can reach the
network even by mistake.

### 4.2 Scope

**Included**

| Collector | Default cadence | Default state |
|---|---|---|
| Session / identity | 30 s | on — requires no permission |
| Lifetime counters | 30 s | on |
| Zone health | 30 s | on |
| Cluster peer state | 30 s (part of session / identity) | on — requires no permission when the target is clustered ([§3.2.9](#32-behaviours-that-shape-the-design)) |
| Cluster configuration detail | 60 s | **off** — costs `Administration: View` |
| Statistics window split | 300 s | **off** — upstream side effect ([§3.2.6](#32-behaviours-that-shape-the-design)) |

**Excluded — permanent non-goals, not deferrals**

- **`topClients`, `topDomains`, `topBlockedDomains`** — unbounded cardinality,
  and exporting them writes client IP addresses and resolution history into a
  metrics store.
- **Server settings inventory** — the response contains plaintext secrets
  ([§3.2.13](#32-behaviours-that-shape-the-design)). A read-only, secret-free
  exporter should not touch an endpoint whose only content is secrets.
- **DHCP scopes and leases** — outside a DNS exporter's remit, and would carry
  its own non-ISO `MM/DD/YYYY HH:mm:ss` date-parsing burden for no benefit to
  the stated requirements.
- **DNSSEC key state** — the endpoint requires `Zones: Modify`. A read-only
  exporter does not hold a write grant, full stop; this data is not reachable
  without violating N1 and N4, so it is not exported.
- **Username and password login, and token lifecycle** — the exporter
  consumes a pre-created non-expiring API token only. No login flow, no
  refresh, no credentials at rest (N4).
- **Query logs** — a log pipeline's concern, not a metrics exporter's.
- **Cluster-aggregated statistics** — the API can aggregate statistics across a
  cluster from a single node. Deliberately unused: per-node identity is the
  point of the multi-target model (R8).
- **Catalog zone membership** — a zone belonging to a catalog carries a
  `catalog` field naming it ([§3.2.7](#32-behaviours-that-shape-the-design)).
  This is a zone-provisioning relationship, not a health signal, and no
  requirement calls for it.
- **Cluster peer network addresses and connection URLs** — the peer inventory
  that supplies `type` and `state` ([§3.2.9](#32-behaviours-that-shape-the-design))
  carries each peer's address and URL alongside them. They are received
  whether or not the exporter wants them, and are read and discarded rather
  than exported: a compromised metrics store should not become an inventory
  of internal network addresses, and no requirement calls for them.

### 4.3 Multi-target model

One Prometheus scrape target per DNS node.

- Targets are **named** in configuration. The name is the `?target=` value and
  becomes Prometheus's `instance` label through relabeling.
- `GET /metrics?target=dns-a` renders that target only.
- `GET /metrics` with no parameter renders the **global** registry alone:
  Node.js runtime metrics, `technitium_exporter_build_info` and
  `technitium_exporter_targets`. It does not aggregate targets.
- An unknown `?target=` returns **400**, never an empty 200. A typo in a scrape
  configuration must fail loudly.

Because per-node identity comes from `instance`, the exporter never attaches a
constant `instance` label of its own. There is therefore no `exported_instance`
collision and no dependence on `honor_labels`.

```yaml
scrape_configs:
  - job_name: technitium
    metrics_path: /metrics
    static_configs:
      - targets: [dns-a, dns-b, dns-c]
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: technitium-metrics-exporter:10053
```

### 4.4 One registry per target

Each target owns its own `@prometheus-io/client` `Registry`. This delivers three
properties at once:

1. **Isolation (N3).** A label-set change or render failure for one target
   cannot affect another target's response.
2. **Correct series disappearance.** The render path resets that target's
   collector metrics and repopulates them from the snapshot, so a deleted zone
   or a departed cluster peer stops being exported rather than freezing at its
   last observed value.
3. **No cross-target label-dimension conflicts**, which in a shared registry
   can fail an entire exposition.

Poll loops are independent for the same reason: per-target startup jitter,
per-target failure state, per-target error classification. A hard-down node
never delays or fails another target's cycle.

### 4.5 Technology

- Node.js **≥ 24**, TypeScript **7.x**, ESM, `strict` plus
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- Runtime dependencies: **`@prometheus-io/client`** (the official Prometheus
  client library for Node.js) and **`undici`**, and nothing else. No web
  framework, no CLI library, no native addons — the last is enforced by a
  dedicated guard script, run in CI once CI exists.
- `node:http` and `node:https` directly for the metrics listener.
- Tests via `node:test`. Lint and format via Biome.
- Apache-2.0.

Default listen port **10053**, provisional pending a registered Prometheus port
allocation ([§9](#9-open-questions)).

---

## 5. Metric surface

Prefix `technitium_` for DNS-server data, `technitium_exporter_` for the
exporter's own health. Once built, `METRICS.md` will be generated from the
live metric declarations, with a test asserting the committed file matches a
fresh generation, so the reference cannot drift from the code.

### 5.1 Per-node health

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `technitium_up` | gauge | — | 1 if and only if the last cycle reached this node **and** the token was accepted (N6) |
| `technitium_collector_success` | gauge | `collector` | Per-collector outcome, so "zones fine, cluster failing" is visible rather than collapsed into one boolean |
| `technitium_server_version_info` | gauge | `version` | Always 1 |
| `technitium_server_version_supported` | gauge | — | 0 below v15.0 |
| `technitium_server_domain_info` | gauge | `dns_server_domain` | Always 1. The node's own canonical identity, for detecting a mis-pointed target |
| `technitium_permission_granted` | gauge | `section` | The token's actual permissions, read from the server |
| `technitium_cluster_initialized` | gauge | — | Available with **no** `Administration` grant |

`technitium_up` describes the DNS node. Prometheus's own `up` describes the
exporter. Both exist, they mean different things, and both are needed: only
`up` can fire when the exporter process itself is gone.

### 5.2 Zone health

Internal system zones (`localhost`, `0.in-addr.arpa`, the `ip6.arpa` roots and
so on) are excluded by default, with the excluded count exported so the filter
is never invisible.

| Metric | Type | Labels | Exported for |
|---|---|---|---|
| `technitium_zone_soa_serial` | gauge | `zone`, `type` | all zones — the divergence signal (R1) |
| `technitium_zone_disabled` | gauge | `zone`, `type` | all zones |
| `technitium_zone_last_modified_timestamp_seconds` | gauge | `zone`, `type` | all zones |
| `technitium_zone_dnssec_status` | gauge | `zone`, `status` | all zones — state set |
| `technitium_zone_expiry_timestamp_seconds` | gauge | `zone`, `type` | secondary-family only |
| `technitium_zone_expired` | gauge | `zone`, `type` | secondary-family only |
| `technitium_zone_sync_failed` | gauge | `zone`, `type` | secondary-family only |
| `technitium_zone_notify_failed` | gauge | `zone`, `type` | primary-family only |
| `technitium_zone_notify_failed_peers` | gauge | `zone`, `type` | primary-family only — a **count** |
| `technitium_zones_visible` | gauge | — | zones this token can see |
| `technitium_zones_by_type` | gauge | `type` | per-type counts, so an alert can assert an expected inventory |
| `technitium_zones_excluded_internal` | gauge | — | zones removed by the internal-zone filter |

Absent conditional fields produce **absent series**, never zero. A secondary
with no reported `expiry` is a different fact from one whose expiry falls at the
Unix epoch, and only one of the two is worth alerting on.

`notifyFailedFor` is reduced to a count rather than exported as peer-name
labels, because otherwise a zone's own configuration would drive the exporter's
cardinality (N7).

### 5.3 Detecting a token that cannot see every zone

`/api/zones/list` is permission-filtered per zone
([§3.2.4](#32-behaviours-that-shape-the-design)), but the zone total in the
statistics response is read from the server's authoritative zone manager and is
**not** filtered. Exporting both makes the gap alertable instead of silent:

| Metric | Source |
|---|---|
| `technitium_zones_visible` | count of entries returned by `/api/zones/list` |
| `technitium_zones_reported` | the server's own zone total, from `/api/dashboard/stats/get` |

Inequality means the token is missing `View` on at least one zone and the
exporter is under-reporting. A shipped alert covers it.

This depends on the opt-in statistics collector. When that is off, the install
guides direct users to assert an absolute expected count against
`technitium_zones_by_type` instead.

### 5.4 Normalised lifetime counters

Parsed from `metrics/text` and re-exported with a stable prefixed name, real
`HELP` text, and time in seconds. Both upstream spellings map to one output
name (R5, N8).

| Upstream, either spelling | Exported |
|---|---|
| `total_queries` / `queries_total` | `technitium_queries_total` |
| `total_no_error` / `no_error_total` | `technitium_no_error_total` |
| `total_server_failure` / `server_failure_total` | `technitium_server_failure_total` |
| `total_nx_domain` / `nx_domain_total` | `technitium_nx_domain_total` |
| `total_refused` / `refused_total` | `technitium_refused_total` |
| `total_authoritative` / `authoritative_total` | `technitium_authoritative_total` |
| `total_recursive` / `recursive_total` | `technitium_recursive_total` |
| `total_cached` / `cached_total` | `technitium_cached_total` |
| `total_blocked` / `blocked_total` | `technitium_blocked_total` |
| `total_dropped` / `dropped_total` | `technitium_dropped_total` |
| `total_clients` / `clients_total` | `technitium_clients_total` |
| `uptime_seconds` | `technitium_uptime_seconds` |
| `start_time` (milliseconds) | `technitium_start_time_seconds` |

Alongside them:

- `technitium_lifetime_counters_supported` — 0 when the endpoint is missing or
  unparseable.
- `technitium_exporter_unknown_native_metric_total{name}` — increments the
  moment upstream adds or renames a metric, which turns the next upstream
  change into a visible signal instead of a silent gap.

These are genuine Prometheus **counters**, because the underlying values are
monotonic lifetime totals.

Each of the thirteen fields above is independently absent-or-present, not
all-or-nothing: a single field missing from an otherwise well-formed response
(the exact shape of an in-progress upstream rename) is not a parse failure. It
increments `technitium_exporter_unknown_native_metric_total` for whatever new
name appeared and leaves that field's own series genuinely absent, rather than
erroring the entire poll cycle and discarding the one signal designed to make
the rename visible. This is distinct from a fully failed poll cycle (server
unreachable, token rejected): there, every already-registered counter and
gauge here holds its last known value rather than resetting, the same way
Prometheus itself treats a target that's briefly unreachable — only a field
that's missing from an otherwise-*successful* response goes absent.

### 5.5 Window-derived statistics

**Design rule: a sliding-window value is never exported as a counter.** It is
not monotonic, so `rate()` and `increase()` would read every window slide as a
counter reset and fabricate traffic. Window values are gauges, named so that
their nature is legible, and the window length is exported alongside them so
PromQL can convert honestly.

| Metric | Type | Labels |
|---|---|---|
| `technitium_stats_window_queries` | gauge | `protocol` — all five values always exported, 0 when absent from the response |
| `technitium_stats_window_queries_by_response` | gauge | `response_type` — all five |
| `technitium_stats_window_queries_by_type` | gauge | `query_type` — **off by default**; upstream trims to the top ten, so the label set churns |
| `technitium_stats_window_seconds` | gauge | — |

Values in the same response that are **live current state** rather than
window-derived — they are read from the zone and cache managers at request time
— are named without `window`, so the distinction is visible in the metric name
itself: `technitium_cached_entries`, `technitium_allowed_zones`,
`technitium_blocked_zones`, `technitium_allow_list_zones`,
`technitium_block_list_zones`.

### 5.6 Cluster

Three of these seven metrics are sourced from the peer inventory in
`/api/user/session/get` ([§3.2.9](#32-behaviours-that-shape-the-design)) and
therefore need **no permission** — they are populated on every poll cycle a
clustered target already makes for `technitium_up`, independently of whether
the remaining four are enabled. Those four need a separate,
`Administration: View`-gated call to `/api/admin/cluster/state` on a slower
cadence, because that configuration detail is not exposed anywhere else.

| Metric | Type | Labels | Source | Permission |
|---|---|---|---|---|
| `technitium_cluster_node_state` | gauge | `node_name`, `node_type`, `state` — state set over all four values | `session/get` peer inventory | none |
| `technitium_cluster_node_last_seen_timestamp_seconds` | gauge | `node_name` — absent for the node's own entry | `session/get` peer inventory | none |
| `technitium_cluster_nodes` | gauge | — | `session/get` peer inventory | none |
| `technitium_cluster_config_last_synced_timestamp_seconds` | gauge | — | `admin/cluster/state` | `Administration: View` |
| `technitium_cluster_heartbeat_refresh_interval_seconds` | gauge | — | `admin/cluster/state` | `Administration: View` |
| `technitium_cluster_heartbeat_retry_interval_seconds` | gauge | — | `admin/cluster/state` | `Administration: View` |
| `technitium_cluster_config_refresh_interval_seconds` | gauge | — | `admin/cluster/state` | `Administration: View` |

`technitium_cluster_node_last_seen_timestamp_seconds`'s never-sentinel handling
([§3.2.10](#32-behaviours-that-shape-the-design)) is documented for
`admin/cluster/state`'s own `lastSeen` field. The `session/get` peer
inventory's `lastSeen` is a distinct field: observed absent for a node's own
entry and as an ordinary timestamp for a peer that has connected; its
behaviour for a peer that has never connected is unconfirmed. Both an absent
key and a never-sentinel resolve to the same absent series, so either
behaviour renders correctly without a code change once confirmed.

Peer network addresses and connection URLs arrive in the same `session/get`
peer inventory that supplies `type` and `state`, unrequested and regardless of
whether the configuration-detail collector is enabled ([§4.2](#42-scope)).
They are read and discarded, never exported.

### 5.7 Exporter self-observability

Per target: `technitium_exporter_last_successful_poll_timestamp_seconds`,
`_cache_age_seconds` (computed at collect time from a monotonic clock),
`_poll_total`, `_poll_errors_total{reason}`, `_poll_duration_seconds`,
`_upstream_requests_total{endpoint,status_code}`,
`_upstream_request_duration_seconds{endpoint}`, `_parse_errors_total{group}`,
`_unknown_enum_total{metric,value}`, `_series` (the cardinality tripwire, N7),
`_tls_verification_disabled`.

Global: `technitium_exporter_build_info{version,commit,node_version}`,
`technitium_exporter_targets`, and Node.js runtime metrics.

`reason` is a bounded set: `auth`, `timeout`, `network`, `http_5xx`, `parse`,
`api_error`, `unknown`. `api_error` exists because the
HTTP-200-with-error-envelope case
([§3.2.1](#32-behaviours-that-shape-the-design)) has no equivalent in a
status-code-only taxonomy.

---

## 6. Configuration and security

Environment variables only, loaded once at startup, validated, then frozen. A
redacted effective-configuration summary is logged at startup. The full
reference lives in `example.env`.

### 6.1 Targets

```
TECHNITIUM_TARGETS=dns-a=https://dns-a.example.com:53443,dns-b=https://dns-b.example.com:53443
TECHNITIUM_API_TOKEN=<token>
TECHNITIUM_API_TOKEN__DNS_A=<per-target override>
TECHNITIUM_CA_BUNDLE_PATH=/etc/technitium-exporter/ca.pem
TECHNITIUM_CA_BUNDLE_PATH__DNS_A=...
TECHNITIUM_TLS_INSECURE_SKIP_VERIFY=false
TECHNITIUM_TLS_INSECURE_SKIP_VERIFY__DNS_A=false
```

- A target name matches `^[a-z0-9][a-z0-9_-]*$`, case-insensitive, and must be
  unique. The `__<NAME>` override suffix is the target name upper-cased with
  `-` replaced by `_`.
- **An override suffix matching no configured target is a startup error**, not
  a silently ignored variable. Otherwise a typo means a node quietly uses the
  wrong token, or no CA bundle at all.
- A base URL is an opaque prefix: never parsed, never reconstructed, only
  appended to. IPv6 literals are therefore supplied bracketed, as in any URL.
- Per-target CA bundles are first-class, not an afterthought: the Technitium
  web service commonly presents a private-CA or self-signed certificate.
- `TLS_INSECURE_SKIP_VERIFY` logs a loud startup warning and sets
  `technitium_exporter_tls_verification_disabled 1`, so a temporary workaround
  cannot become invisible permanent state.

### 6.2 Behaviour

```
METRICS_PORT=10053
METRICS_BIND_ADDRESS=0.0.0.0
POLL_INTERVAL_SECONDS=30
CLUSTER_POLL_INTERVAL_SECONDS=60     # configuration-detail collector only; peer state rides the main poll
STATS_POLL_INTERVAL_SECONDS=300      # hard floor 60
REQUEST_TIMEOUT_SECONDS=15
ENABLE_CLUSTER_COLLECTOR=false       # gates configuration-detail metrics only (§5.6); peer state needs no flag
ENABLE_STATS_COLLECTOR=false
ENABLE_STATS_QUERY_TYPES=false
ZONES_INCLUDE_INTERNAL=false
ENABLE_DEFAULT_METRICS=true
LOG_LEVEL=info
LOG_FORMAT=json
METRICS_TLS_CERT_PATH=
METRICS_TLS_KEY_PATH=
METRICS_TLS_CLIENT_CA_PATH=
METRICS_TLS_MIN_VERSION=TLSv1.2
```

`STATS_POLL_INTERVAL_SECONDS` has a hard floor of 60 seconds. Because that
endpoint performs reverse-DNS resolution on every call
([§3.2.6](#32-behaviours-that-shape-the-design)), a fast cadence would turn the
exporter into a load generator against the very server it is monitoring.

### 6.3 Read-only enforcement

The HTTP client exposes only `get()`. On this API that is not sufficient,
because destructive endpoints accept GET
([§3.2.5](#32-behaviours-that-shape-the-design)). The client therefore also
holds a frozen allowlist of the exact endpoint paths in
[§3.1](#31-endpoints-used) and throws on anything else.

N1 is satisfied structurally: there is no code path that can construct a
request to a mutating endpoint, and a test asserts that a sample of destructive
paths is rejected.

### 6.4 Least-privilege token

1. Create a dedicated user. Never `admin`.
2. **A newly created non-admin user already has `View` on every section
   except `Administration` and `Settings` — this is default behaviour, not
   something observed only in one environment.** That default includes
   `Zones` at the section level, but does not extend to individual zones: the
   zone list is filtered per zone, so `View` must still be granted on each
   zone the exporter should see ([§3.2.4](#32-behaviours-that-shape-the-design)).
3. Because most sections default to granted, and this exporter only reads
   `Dashboard` and `Zones`, explicitly restrict `View` on every section it
   does not use: `Cache`, `Allowed`, `Blocked`, `Apps`, `DnsClient`,
   `DhcpServer`, `Logs`. None of this default access includes `Modify` or
   `Delete`, so it is not a write exposure, but it is a wider read blast
   radius than "grant only what's listed" implies — a compromised token could
   otherwise read DHCP leases, installed apps and logs, none of which this
   exporter touches. `Settings` and `Administration` are already denied by
   default and need no restricting.
4. Only if the cluster **configuration-detail** metrics are wanted (heartbeat
   and refresh intervals, config sync time — [§5.6](#56-cluster)), add
   `Administration: View`, and note that this grant also exposes users, groups
   and sessions to that token. Basic cluster peer state and
   `technitium_cluster_initialized` need no grant at all, so "is clustering
   up, and are peers connected" monitoring does not require it.
5. Create a non-expiring API token once, and store it as a secret.

The exporter never needs, accepts or stores a password.

---

## 7. Dashboard and alerting

The shipped dashboard is generated by a script rather than hand-edited. The
exporter-health row comes **first**: a dashboard that looks green while the
exporter is dead is the worst possible outcome. Then per-node overview, zone
health with SOA serial divergence as the headline panel, transfer health,
protocol split, and cluster state.

Shipped rules come with `promtool` unit tests asserting that every rule **both
fires and does not fire**. A one-directional test passes just as well against a
rule that fires unconditionally.

| Alert | Expression shape |
|---|---|
| `TechnitiumExporterAbsent` | `up{job="technitium"} == 0` — the only rule that can fire when the exporter process is gone, since every `technitium_*` series stops existing |
| `TechnitiumNodeDown` | `technitium_up == 0` |
| `TechnitiumCollectorFailing` | `technitium_collector_success == 0` |
| `TechnitiumZoneSerialDivergence` | `max by (zone) (technitium_zone_soa_serial) != min by (zone) (…)` |
| `TechnitiumZoneTransferStale` | `technitium_zone_expiry_timestamp_seconds - time() < threshold` — fires while there is still time to act |
| `TechnitiumZoneSyncFailed` | `technitium_zone_sync_failed == 1` |
| `TechnitiumZoneNotifyFailed` | `technitium_zone_notify_failed == 1` |
| `TechnitiumZoneExpired` | `technitium_zone_expired == 1` — critical, fires immediately |
| `TechnitiumZoneDisabled` | `technitium_zone_disabled == 1` |
| `TechnitiumZoneVisibilityMismatch` | `technitium_zones_visible != technitium_zones_reported` ([§5.3](#53-detecting-a-token-that-cannot-see-every-zone)) |
| `TechnitiumClusterNodeUnreachable` | `technitium_cluster_node_state{state="Unreachable"} == 1` |
| `TechnitiumClusterNodeStateUnknown` | `technitium_cluster_node_state{state="Unknown"} == 1` |
| `TechnitiumServerVersionUnsupported` | `technitium_server_version_supported == 0` |
| `TechnitiumStaleData` | `technitium_exporter_cache_age_seconds` above a multiple of the poll interval |
| `TechnitiumCardinalityGrowth` | `technitium_exporter_series` above a documented ceiling |

A test cross-checks every metric name referenced by the dashboard and by the
rules against the exporter's actual declarations, so a rename cannot silently
leave either querying a series that no longer exists.

---

## 8. Deployment

Three supported paths, each with an install guide ending in the same
verification steps.

- **Standalone** — a Node process, plus a systemd unit using `DynamicUser`,
  `ProtectSystem=strict`, `NoNewPrivileges`, and an `EnvironmentFile` at mode
  `0600`.
- **Docker** — a multi-arch image; compose file with `read_only`,
  `cap_drop: ALL` and `no-new-privileges`.
- **Kubernetes** — Deployment (single replica, `Recreate` strategy,
  `automountServiceAccountToken: false`, `runAsNonRoot`,
  `readOnlyRootFilesystem`, `seccompProfile: RuntimeDefault`, all capabilities
  dropped, `/healthz` liveness and `/readyz` readiness), Service, ConfigMap,
  example Secret, and a NetworkPolicy restricting egress to the DNS nodes' web
  service port and ingress to the scraper.

Kubernetes scrape integration is documented **both** ways: a plain
`scrape_configs` snippet, and an optional Prometheus Operator `ServiceMonitor`.
The plain snippet comes first and the `ServiceMonitor` is explicitly marked
optional, because a cluster running Prometheus without the Operator has no such
CRD and applying that manifest there fails.

---

## 9. Open questions

1. **Port 10053 is provisional**, pending a registered Prometheus port
   allocation. Changing it after v1.0.0 breaks every deployed manifest, so it
   must be resolved before the first tag.
2. **Zone-list pagination.** Omitting `pageNumber` returns all zones in one
   call, which is what the exporter wants. Confirm the behaviour at several
   hundred zones, and add pagination if the unpaginated response truncates or
   is slow.
3. **`TechnitiumZoneTransferStale` threshold.** The ideal threshold is a
   fraction of each zone's own SOA `expire`, which `/api/zones/list` does not
   report; reading it would need a records call and a wider grant. The shipped
   rule uses a documented absolute default with tuning instructions.

---

## 10. Stability commitment

`technitium_*` metric names are stable within a major version. The
normalisation layer in [§5.4](#54-normalised-lifetime-counters) exists
precisely so that an upstream rename is a patch release here, rather than a
breaking change for every downstream dashboard and alert rule.
