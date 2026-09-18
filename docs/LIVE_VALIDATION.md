# Live validation

Phase 14's own record: what was checked against real Technitium DNS Server
instances, what changed as a result, and what stayed unconfirmed. See
[docs/IMPLEMENTATION.md](IMPLEMENTATION.md#phase-14--live-validation-and-fixture-replacement)
for the exit bar this satisfies.

## Setup

Two real Technitium 15.4 targets, run standalone against the exporter's own
built `dist/` via `--env-file`:

- A clustered node, reachable as the sole ingress-exposed member of a
  two-node cluster (its peer had no route from the exporter's host).
- A non-clustered secondary, kept in sync with the cluster's zones by
  ordinary secondary zone transfer rather than cluster membership.

Both serve TLS issued by a private CA; the exporter's own
`TECHNITIUM_CA_BUNDLE_PATH` verified it with no
`TECHNITIUM_TLS_INSECURE_SKIP_VERIFY` needed. `ENABLE_CLUSTER_COLLECTOR` and
`ENABLE_STATS_COLLECTOR` were both on for this pass, so every opt-in
collector got real exercise.

## `--dump-raw` captures and fixture reconciliation

`--dump-raw` was run against both targets and the output sanitised with
`scripts/sanitize-fixtures.ts` before anything from it was used. This covers
IMPLEMENTATION.md's "primary" and "cluster member" (the same node) and
"secondary" and "non-clustered standalone" (the other node) — the fourth
distinct combination, a secondary cluster member, was unreachable and stayed
uncaptured.

Every endpoint shape was checked against the corresponding hand-authored
fixture. Most needed no change: `session/get`, `zones/list` for `Primary`/
`Secondary` zones (including the conditional `notifyFailed`/`syncFailed`/
`expiry` field rules), `dashboard/metrics/text`, and `dashboard/stats/get`'s
chart structure all matched the existing assumptions exactly.

Two fixtures were corrected against real data:

- `test/fixtures/session/envelope-invalid-token.json` — the real envelope
  carries `server` and `errorMessage` alongside `status`, not `status` alone.
  Replaced with the real (sanitised) shape; no test depended on the old
  one-field assumption.
- `test/fixtures/cluster/cluster-state.json` — the peer array's real key is
  `clusterNodes`, not `nodes` as DESIGN.md and the fixture both assumed;
  `configRetryIntervalSeconds` is confirmed present in a real capture, where
  it had previously only been assumed present based on (unreliable)
  published API docs. Both corrected in the fixture, the parser's own
  comments, and DESIGN.md §5.6. The fixture's peer-state variety
  (`Unreachable`/`Unknown`, the never-sentinel `lastSeen`) and its
  `configLastSynced` value stay hand-authored — the real cluster available
  for this pass never exposed either.

Everything else stayed hand-authored, by conscious decision, because neither
real target can produce the scenario without changing production zone
configuration or server version:

- `zones-list.json`'s zone-type variety (`Catalog`, `Forwarder`, `Stub`,
  `SecondaryForwarder`, `SecondaryCatalog`), any DNSSEC-signed zone, a
  disabled zone, an "expiryless" secondary, and any zone with
  `internal: true` — confirmed genuinely absent from the raw, unfiltered
  `zones/list` response on both real targets.
- `zones-list-empty.json`, `stats-get-single-label.json` — neither real
  target has zero zones or single-label traffic.
- `stats-get-full.json` — real traffic here never uses the `Tls`/`Https`/
  `Quic` transports or the full query-type set.
- `envelope-error.json`'s `stackTrace` — a real "Access was denied" error
  envelope, captured live, carries no `stackTrace` at all.
- `session-get-pre-v15.json`, the native-metrics legacy-spelling and
  unknown-metric fixtures — would need an older Technitium version.

## Real alert observations

Two alert conditions were observed transitioning from firing to resolved
against live, unprompted infrastructure changes (not deliberately provoked
for this pass):

- The non-clustered secondary's `technitium_zone_sync_failed` and
  `technitium_zone_notify_failed` went from `1` to `0` across every zone on
  the poll cycle immediately after its zone transfer was fixed upstream.
- The clustered node's `technitium_zone_notify_failed` (cluster-internal
  notify to its peer, deliberately left off because cluster notify targets
  are IP-pinned and the peer's IP isn't stable) went from `1` to `0` on the
  next poll cycle after cluster notify was actually enabled upstream.

Both confirm the exporter reflects genuine upstream state changes within one
poll cycle, with no stale readback.

## Least-privilege token walkthrough (D§6.4)

Run against the non-clustered secondary, in two stages:

1. **Coarse: the entire `Zones: View` section grant revoked.** The
   exporter's own permission gate skipped the zones collector entirely —
   `technitium_zones_visible` went genuinely absent, not a smaller present
   number, and `technitium_collector_success{collector="zones"}` dropped to
   `0`. This is a different, more extreme case than D§6.4 describes.
2. **Exact: `View` withheld on three specific zones, section grant left
   intact.** `zones/list` returned a real, non-empty, smaller result (7 of
   10 zones); the collector did not skip. `technitium_zones_visible` (`7`)
   and `technitium_zones_reported` (`10`, unaffected) were both present and
   unequal, with the target reporting as non-clustered
   (`technitium_cluster_initialized == 0`) — exactly the condition
   `TechnitiumZoneVisibilityMismatch` is designed to catch, confirmed
   genuinely true against real data rather than only via crafted `promtool`
   input.

`ZONES_INCLUDE_INTERNAL` was set to `true` for this walkthrough per
IMPLEMENTATION.md's own note (at the default `false` the comparison isn't
meaningful) and reverted afterward.

## `Administration: View` walkthrough and the cluster config-detail metrics

`Administration: View` was granted temporarily on the clustered node to
capture a real `admin/cluster/state` success body (previously only its
access-denied shape had been captured). Findings:

- `heartbeatRefreshIntervalSeconds`, `heartbeatRetryIntervalSeconds`,
  `configRefreshIntervalSeconds`, and `configRetryIntervalSeconds` were all
  present.
- `configLastSynced` was genuinely absent, even though the node was actively
  clustered and actively heartbeating — this was not a "not yet synced" or
  "not clustered" case. This confirms the field *can* be absent in a healthy
  cluster; it still doesn't confirm whether it can carry §3.2.10's
  never-sentinel when present, since no capture has yet shown it present at
  all. That specific question (D§9.3) stays open.

## A real, permission-independent zone-visibility gap on clustered nodes

While investigating the least-privilege walkthrough, the clustered node
showed `technitium_zones_visible` under-counting `technitium_zones_reported`
even with a fully-permissioned token — a finding independent of the
permission tests above. Cross-referencing against the Technitium dashboard's
own zone list (same admin session) identified the two zones `zones/list`
never returns, under any parameters tried, including
`includeInternal=true`: the cluster's own catalog zone and its
DNSSEC-signed cluster-coordination zone. `dashboard/stats/get`'s zone total
counts both; `zones/list` counts neither, regardless of token permission.
The non-clustered secondary showed no such gap under a fully-permissioned
token, confirming the comparison is sound there.

`TechnitiumZoneVisibilityMismatch` now excludes clustered instances
(`unless on (instance) technitium_cluster_initialized == 1`) rather than
encoding this gap's exact size, since nothing here confirms that size is
stable across cluster topologies or Technitium versions. See
[docs/DESIGN.md §5.3](DESIGN.md#53-detecting-a-token-that-cannot-see-every-zone).
Regression coverage for both the firing (non-clustered) and silent
(clustered) cases lives in `alerts/technitium-dns.test.yaml`.

## A tooling bug found along the way

`scripts/sanitize-fixtures.ts` dropped its own input path whenever `--out`
was omitted (an off-by-one: `args.indexOf("--out")` returns `-1` when
absent, and `-1 + 1` collided with the input path's own default index).
Fixed, with the argument-resolution logic extracted into an exported,
directly-unit-tested function.

## Explicitly out of scope for this pass

- **`TechnitiumZoneTransferStale`**, confirmed only via `promtool`'s crafted
  data, not against a real, deliberately-stalled transfer approaching actual
  SOA expiry — that needs a transfer left broken for much longer than this
  pass's real (unprompted) transfer failure lasted.
- **`zones/list` pagination behaviour at scale** (D§9, open question 2) —
  both real targets have on the order of ten zones, far below anything that
  would exercise pagination or reveal a slow/truncated response.
- **Fixture replacement beyond what's listed above** — the zone-type/DNSSEC/
  cluster-peer-state variety, the empty-zone-list case, the pre-v15 session
  shape, and the legacy/unknown-metric-name native text fixtures all remain
  hand-authored, since none is producible from the two real targets
  available without changing production zone configuration or server
  version.

These were consciously deferred rather than missed: the exit bar's
"observed firing at least once against real **or crafted** data" is already
met for every shipped alert via the existing `promtool` test suite
(`npm run check:alerts`), independent of live validation. This pass adds
real-data confirmation for several alerts and metric shapes on top of that
baseline, not a replacement for it.
