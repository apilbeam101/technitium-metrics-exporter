import type { Gauge, Registry } from "@prometheus-io/client";
import type { ClusterConfigDetail } from "../api/cluster.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";

type IntervalField =
  | "heartbeatRefreshIntervalSeconds"
  | "heartbeatRetryIntervalSeconds"
  | "configRefreshIntervalSeconds";

interface FieldSpec {
  readonly name: string;
  readonly help: string;
}

// Keyed by field for the same reason native-metrics.ts's COUNTER_FIELD_SPECS
// is: a mapped Record over IntervalField makes a dropped entry a compile
// error instead of a silent gap.
const INTERVAL_FIELD_SPECS: Readonly<Record<IntervalField, FieldSpec>> = {
  heartbeatRefreshIntervalSeconds: {
    name: "technitium_cluster_heartbeat_refresh_interval_seconds",
    help: "Configured cluster heartbeat refresh interval",
  },
  heartbeatRetryIntervalSeconds: {
    name: "technitium_cluster_heartbeat_retry_interval_seconds",
    help: "Configured cluster heartbeat retry interval",
  },
  configRefreshIntervalSeconds: {
    name: "technitium_cluster_config_refresh_interval_seconds",
    help: "Configured cluster configuration refresh interval",
  },
};

function intervalFields(): readonly IntervalField[] {
  return Object.keys(INTERVAL_FIELD_SPECS) as IntervalField[];
}

export interface ClusterMetrics {
  readonly intervals: Readonly<Record<IntervalField, AbsentUntilSetGauge>>;
  readonly configLastSynced: AbsentUntilSetGauge;
  // Shared with session-metrics.ts's own Gauge instance, same reason
  // native-metrics.ts's collectorSuccess field is: this collector's outcome
  // and session-collector.ts's permission-gating both write to
  // technitium_collector_success{collector="cluster"} (D§4.4).
  readonly collectorSuccess: Gauge<"collector">;
}

export function createClusterMetrics(
  registry: Registry,
  collectorSuccess: Gauge<"collector">,
): ClusterMetrics {
  const intervals = {} as Record<IntervalField, AbsentUntilSetGauge>;
  for (const field of intervalFields()) {
    const spec = INTERVAL_FIELD_SPECS[field];
    intervals[field] = new AbsentUntilSetGauge(registry, spec.name, spec.help);
  }

  return {
    intervals,
    configLastSynced: new AbsentUntilSetGauge(
      registry,
      "technitium_cluster_config_last_synced_timestamp_seconds",
      "Time the cluster configuration was last synced; absent if never synced",
    ),
    collectorSuccess,
  };
}

// collector_success is set last, the same ordering native-metrics.ts and
// session-metrics.ts use: a throw partway through this function must not
// leave it at 1 for a poll cycle that didn't actually finish applying its
// result.
export function applyClusterConfigSuccess(
  metrics: ClusterMetrics,
  detail: ClusterConfigDetail,
): void {
  for (const field of intervalFields()) {
    metrics.intervals[field].setOrClear(detail[field]);
  }
  metrics.configLastSynced.setOrClear(detail.configLastSyncedSeconds);

  metrics.collectorSuccess.labels({ collector: "cluster" }).set(1);
}

// The four value fields are deliberately left untouched here — a transient
// poll failure (server unreachable, auth rejected) freezes them at their
// last known value, the same freezing semantic native-metrics.ts's
// applyNativeFailure uses for its own thirteen fields, rather than clearing
// them to absent on every failed cycle.
export function applyClusterConfigFailure(metrics: ClusterMetrics): void {
  metrics.collectorSuccess.labels({ collector: "cluster" }).set(0);
}

// Unlike applyClusterConfigFailure (a transient poll failure, which freezes
// the four value fields at their last known value), a target that has
// stopped being clustered has no cluster configuration to report at all —
// the same "no cluster claims to make" reasoning session-metrics.ts's own
// applyClusterPeers(metrics, undefined) uses when a target loses clustering.
// Clearing collector_success's own "cluster" child, not just setting it to
// 0, removes the series entirely rather than leaving a stale claim that this
// collector still applies to a target it no longer does.
export function applyClusterConfigNotClustered(metrics: ClusterMetrics): void {
  for (const field of intervalFields()) {
    metrics.intervals[field].clear();
  }
  metrics.configLastSynced.clear();
  metrics.collectorSuccess.remove({ collector: "cluster" });
}
