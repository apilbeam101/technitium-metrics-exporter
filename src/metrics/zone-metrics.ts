import { type Counter, Gauge, type Registry } from "@prometheus-io/client";
import { DNSSEC_STATUSES, ZONE_TYPES, type Zone } from "../domain/zone.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";
import { classifyStateSetValue, type StateSetClassification } from "./state-set.ts";

// Zone type is used as an ordinary label on most per-zone metrics below
// (D§5.2's table), not rendered as its own dedicated state-set series, but
// every zone still passes through this classifier exactly once (in
// classifyZones below) so an unrecognized upstream type can never grow this
// label to unbounded cardinality (N7) and is still counted via unknownEnum,
// the same way session-metrics.ts bounds its cluster peer node_type label.
const UNRECOGNIZED_TYPE_LABEL = "unrecognized";

// Same shape as session-metrics.ts's own local recordEnumOutcome: a value
// genuinely absent upstream is distinct from one that's present but outside
// the recognized set, both counted under this shared
// technitium_exporter_unknown_enum_total series (D§3.3), but never under a
// value that could collide with a real enum member.
function recordEnumOutcome(
  unknownEnum: Counter<"metric" | "value">,
  metric: string,
  classification: StateSetClassification<string>,
): void {
  switch (classification.kind) {
    case "recognized":
      return;
    case "unrecognized":
      unknownEnum.inc({ metric, value: classification.value });
      return;
    case "absent":
      unknownEnum.inc({ metric, value: "(absent)" });
      return;
    default: {
      const exhaustive: never = classification;
      void exhaustive;
      return;
    }
  }
}

interface ClassifiedZone {
  readonly zone: Zone;
  readonly typeLabel: string;
}

// Classifies zone.type exactly once per zone — reused for both the
// technitium_zones_by_type bucket (every zone, D§5.3) and the per-zone type
// label below (internal-filtered), so an unrecognized type is counted in
// unknownEnum exactly once per zone, not once per metric that happens to use
// the type.
function classifyZones(metrics: ZoneMetrics, zones: readonly Zone[]): readonly ClassifiedZone[] {
  return zones.map((zone) => {
    const classification = classifyStateSetValue(zone.type, ZONE_TYPES);
    recordEnumOutcome(metrics.unknownEnum, "zone_type", classification);
    const typeLabel =
      classification.kind === "recognized" ? classification.value : UNRECOGNIZED_TYPE_LABEL;
    metrics.zonesByType.labels({ type: typeLabel }).inc();
    return { zone, typeLabel };
  });
}

export interface ZoneMetrics {
  readonly soaSerial: Gauge<"zone" | "type">;
  readonly disabled: Gauge<"zone" | "type">;
  readonly lastModified: Gauge<"zone" | "type">;
  readonly dnssecStatus: Gauge<"zone" | "status">;
  readonly expiry: Gauge<"zone" | "type">;
  readonly expired: Gauge<"zone" | "type">;
  readonly syncFailed: Gauge<"zone" | "type">;
  readonly notifyFailed: Gauge<"zone" | "type">;
  readonly notifyFailedPeers: Gauge<"zone" | "type">;
  // Label-free, so genuinely absent (not a phantom 0) before the first
  // successful poll and after a failed one requires absent-gauge.ts's
  // wrapper — a plain Gauge's reset() can only zero its value, never remove
  // the series, since there's no label combination to remove.
  readonly zonesVisible: AbsentUntilSetGauge;
  readonly zonesByType: Gauge<"type">;
  readonly zonesExcludedInternal: AbsentUntilSetGauge;
  // Shared with session-metrics.ts's own Gauge/Counter instances (D§4.4):
  // this collector's outcome and unrecognized-enum events land in the same
  // technitium_collector_success{collector="zones"} and
  // technitium_exporter_unknown_enum_total series session-collector.ts's
  // permission gating and session-metrics.ts's own enum handling already
  // write to, rather than each registering a duplicate of the same name,
  // which a Registry rejects.
  readonly collectorSuccess: Gauge<"collector">;
  readonly unknownEnum: Counter<"metric" | "value">;
}

export function createZoneMetrics(
  registry: Registry,
  collectorSuccess: Gauge<"collector">,
  unknownEnum: Counter<"metric" | "value">,
): ZoneMetrics {
  const registers = [registry];

  return {
    soaSerial: new Gauge<"zone" | "type">({
      name: "technitium_zone_soa_serial",
      help: "SOA serial for this zone, so serial divergence across nodes is a single PromQL query",
      labelNames: ["zone", "type"],
      registers,
    }),
    disabled: new Gauge<"zone" | "type">({
      name: "technitium_zone_disabled",
      help: "1 if this zone is disabled",
      labelNames: ["zone", "type"],
      registers,
    }),
    lastModified: new Gauge<"zone" | "type">({
      name: "technitium_zone_last_modified_timestamp_seconds",
      help: "Unix time this zone was last modified",
      labelNames: ["zone", "type"],
      registers,
    }),
    dnssecStatus: new Gauge<"zone" | "status">({
      name: "technitium_zone_dnssec_status",
      help: "This zone's DNSSEC status, as a state set",
      labelNames: ["zone", "status"],
      registers,
    }),
    expiry: new Gauge<"zone" | "type">({
      name: "technitium_zone_expiry_timestamp_seconds",
      help: "Unix time this zone's SOA expires; absent unless the server reports it",
      labelNames: ["zone", "type"],
      registers,
    }),
    expired: new Gauge<"zone" | "type">({
      name: "technitium_zone_expired",
      help: "1 if this zone has expired; absent unless the server reports it",
      labelNames: ["zone", "type"],
      registers,
    }),
    syncFailed: new Gauge<"zone" | "type">({
      name: "technitium_zone_sync_failed",
      help: "1 if this zone's last transfer attempt failed; absent unless the server reports it",
      labelNames: ["zone", "type"],
      registers,
    }),
    notifyFailed: new Gauge<"zone" | "type">({
      name: "technitium_zone_notify_failed",
      help: "1 if this zone failed to notify at least one secondary; absent unless the server reports it",
      labelNames: ["zone", "type"],
      registers,
    }),
    notifyFailedPeers: new Gauge<"zone" | "type">({
      name: "technitium_zone_notify_failed_peers",
      help: "Count of secondaries this zone failed to notify; absent unless the server reports it",
      labelNames: ["zone", "type"],
      registers,
    }),
    zonesVisible: new AbsentUntilSetGauge(
      registry,
      "technitium_zones_visible",
      "Count of zones this token can see, from zones/list, including internal system zones",
    ),
    zonesByType: new Gauge<"type">({
      name: "technitium_zones_by_type",
      help: "Per-type zone counts, including internal system zones, so an alert can assert an expected inventory",
      labelNames: ["type"],
      registers,
    }),
    zonesExcludedInternal: new AbsentUntilSetGauge(
      registry,
      "technitium_zones_excluded_internal",
      "Count of internal system zones excluded from every other per-zone series",
    ),
    collectorSuccess,
    unknownEnum,
  };
}

// Clears every zone-derived series to genuinely absent, not zero: a hard-down
// or auth-rejected target has no zone inventory claims to make, the same way
// session-metrics.ts's applyClusterPeers(metrics, undefined) clears the
// cluster peer state set on a failed poll (D§4.4). Zone health is a live
// inventory snapshot, not a lifetime total, so this deliberately does NOT
// follow native-metrics.ts's counter-freeze precedent — a frozen
// technitium_zone_expired or technitium_zones_visible would assert stale
// claims about zones that may no longer exist, with collector_success=0 as
// the only signal something's wrong.
function resetZoneSeries(metrics: ZoneMetrics): void {
  metrics.soaSerial.reset();
  metrics.disabled.reset();
  metrics.lastModified.reset();
  metrics.dnssecStatus.reset();
  metrics.expiry.reset();
  metrics.expired.reset();
  metrics.syncFailed.reset();
  metrics.notifyFailed.reset();
  metrics.notifyFailedPeers.reset();
  metrics.zonesByType.reset();
}

export function applyZoneFailure(metrics: ZoneMetrics): void {
  resetZoneSeries(metrics);
  metrics.zonesVisible.clear();
  metrics.zonesExcludedInternal.clear();
  metrics.collectorSuccess.labels({ collector: "zones" }).set(0);
}

// Reset-then-repopulate on every successful poll: this is what makes a zone
// removed between two polls disappear from the output instead of freezing at
// its last observed value (D§4.4's series-disappearance guarantee, applied
// here directly the same way session-metrics.ts's applyClusterPeers does,
// since Phase 7's per-target render/reset machinery doesn't exist yet).
//
// includeInternal mirrors ZONES_INCLUDE_INTERNAL (D§6.2): when true, the
// internal-zone filter this function otherwise applies to every per-zone
// series is a no-op, and technitium_zones_excluded_internal reports 0 rather
// than going unreported.
export function applyZoneSuccess(
  metrics: ZoneMetrics,
  zones: readonly Zone[],
  includeInternal: boolean,
): void {
  resetZoneSeries(metrics);

  metrics.zonesVisible.set(zones.length);

  // Seeds only the seven documented types (D§3.3) at 0, so an alert can
  // assert an expected inventory even for a type with zero zones — the
  // "unrecognized" bucket below is not itself a documented type, so it
  // appears only when classifyZones actually encounters one, keeping the
  // label's domain honest between "zero of this type" and "never seen".
  for (const type of ZONE_TYPES) metrics.zonesByType.labels({ type }).set(0);

  const classified = classifyZones(metrics, zones);
  const exported = includeInternal ? classified : classified.filter(({ zone }) => !zone.internal);
  metrics.zonesExcludedInternal.set(zones.length - exported.length);

  for (const { zone, typeLabel } of exported) {
    const labels = { zone: zone.name, type: typeLabel };

    metrics.soaSerial.labels(labels).set(zone.soaSerial);
    metrics.disabled.labels(labels).set(zone.disabled ? 1 : 0);
    if (zone.lastModifiedSeconds !== undefined) {
      metrics.lastModified.labels(labels).set(zone.lastModifiedSeconds);
    }

    const statusClassification = classifyStateSetValue(zone.dnssecStatus, DNSSEC_STATUSES);
    recordEnumOutcome(metrics.unknownEnum, "zone_dnssec_status", statusClassification);
    for (const candidate of DNSSEC_STATUSES) {
      const isActual =
        statusClassification.kind === "recognized" && candidate === statusClassification.value;
      metrics.dnssecStatus.labels({ zone: zone.name, status: candidate }).set(isActual ? 1 : 0);
    }

    // D§3.2.7: expiry/isExpired/syncFailed and notifyFailed/notifyFailedFor
    // are each present in the upstream response only for the zone families
    // that support them — parseZonesListResponse (api/zones.ts) already
    // encodes that as undefined vs. defined, so gating on presence alone
    // here is sufficient and doesn't re-derive or second-guess the parse
    // boundary's own family judgment.
    if (zone.expirySeconds !== undefined) metrics.expiry.labels(labels).set(zone.expirySeconds);
    if (zone.isExpired !== undefined) metrics.expired.labels(labels).set(zone.isExpired ? 1 : 0);
    if (zone.syncFailed !== undefined) {
      metrics.syncFailed.labels(labels).set(zone.syncFailed ? 1 : 0);
    }
    if (zone.notifyFailed !== undefined) {
      metrics.notifyFailed.labels(labels).set(zone.notifyFailed ? 1 : 0);
    }
    if (zone.notifyFailedPeerCount !== undefined) {
      metrics.notifyFailedPeers.labels(labels).set(zone.notifyFailedPeerCount);
    }
  }

  metrics.collectorSuccess.labels({ collector: "zones" }).set(1);
}
