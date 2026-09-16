import { type Counter, Gauge, type Registry } from "@prometheus-io/client";
import type { StatsWindowDetail } from "../api/stats.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";
import { classifyStateSetValue } from "./state-set.ts";

// D§3.2.6: the exporter always requests type=LastHour (http/client.ts's own
// query param, set by stats-collector.ts), so the window length is a fixed
// fact about this exporter's own request shape, not something the response
// body reports — LastHour's minute-wise buckets sum to one hour.
export const STATS_WINDOW_SECONDS = 3600;

// D§5.5's fixed five-value protocol/response-type domains.
const PROTOCOLS = ["Udp", "Tcp", "Tls", "Https", "Quic"] as const;
const RESPONSE_TYPES = ["Authoritative", "Recursive", "Cached", "Blocked", "Dropped"] as const;

type LiveStateField =
  | "cachedEntries"
  | "allowedZones"
  | "blockedZones"
  | "allowListZones"
  | "blockListZones";

interface FieldSpec {
  readonly name: string;
  readonly help: string;
}

// Keyed by field for the same reason native-metrics.ts's COUNTER_FIELD_SPECS
// is: a mapped Record over LiveStateField makes a dropped entry a compile
// error instead of a silent gap.
const LIVE_STATE_FIELD_SPECS: Readonly<Record<LiveStateField, FieldSpec>> = {
  cachedEntries: {
    name: "technitium_cached_entries",
    help: "Current DNS cache entry count, read live rather than derived from the stats window",
  },
  allowedZones: {
    name: "technitium_allowed_zones",
    help: "Current allowed-zone count, read live rather than derived from the stats window",
  },
  blockedZones: {
    name: "technitium_blocked_zones",
    help: "Current blocked-zone count, read live rather than derived from the stats window",
  },
  allowListZones: {
    name: "technitium_allow_list_zones",
    help: "Current allow-list zone count, read live rather than derived from the stats window",
  },
  blockListZones: {
    name: "technitium_block_list_zones",
    help: "Current block-list zone count, read live rather than derived from the stats window",
  },
};

function liveStateFields(): readonly LiveStateField[] {
  return Object.keys(LIVE_STATE_FIELD_SPECS) as LiveStateField[];
}

// Counts an entry from the response outside the recognized five-value
// domain into the shared unknown-enum series (D§3.3, N7) instead of adding
// it as a sixth label — protocolTypeChartData/queryResponseChartData's own
// domains are fixed by D§5.5's table, unlike queryTypeChartData's dynamic,
// upstream-trimmed one.
function recordUnrecognized(
  unknownEnum: Counter<"metric" | "value">,
  metric: string,
  recognized: readonly string[],
  zipped: ReadonlyMap<string, number>,
): void {
  for (const label of zipped.keys()) {
    if (classifyStateSetValue(label, recognized).kind === "unrecognized") {
      unknownEnum.inc({ metric, value: label });
    }
  }
}

export interface StatsMetrics {
  readonly queriesByProtocol: Gauge<"protocol">;
  readonly queriesByResponseType: Gauge<"response_type">;
  // Absent entirely (never constructed) unless ENABLE_STATS_QUERY_TYPES is
  // on — D§5.5's off-by-default gate, structural rather than a permanently-
  // empty series.
  readonly queryTypes: Gauge<"query_type"> | undefined;
  readonly windowSeconds: AbsentUntilSetGauge;
  readonly zonesReported: AbsentUntilSetGauge;
  readonly liveState: Readonly<Record<LiveStateField, AbsentUntilSetGauge>>;
  // Shared with session-metrics.ts's own Gauge/Counter instances (D§4.4),
  // the same sharing native-metrics.ts and zone-metrics.ts already do.
  readonly collectorSuccess: Gauge<"collector">;
  readonly unknownEnum: Counter<"metric" | "value">;
}

export function createStatsMetrics(
  registry: Registry,
  collectorSuccess: Gauge<"collector">,
  unknownEnum: Counter<"metric" | "value">,
  includeQueryTypes: boolean,
): StatsMetrics {
  const registers = [registry];

  const liveState = {} as Record<LiveStateField, AbsentUntilSetGauge>;
  for (const field of liveStateFields()) {
    const spec = LIVE_STATE_FIELD_SPECS[field];
    liveState[field] = new AbsentUntilSetGauge(registry, spec.name, spec.help);
  }

  return {
    queriesByProtocol: new Gauge<"protocol">({
      name: "technitium_stats_window_queries",
      help: "Queries in the current statistics window by transport protocol; all five always present",
      labelNames: ["protocol"],
      registers,
    }),
    queriesByResponseType: new Gauge<"response_type">({
      name: "technitium_stats_window_queries_by_response",
      help: "Queries in the current statistics window by response type; all five always present",
      labelNames: ["response_type"],
      registers,
    }),
    queryTypes: includeQueryTypes
      ? new Gauge<"query_type">({
          name: "technitium_stats_window_queries_by_type",
          help: "Queries in the current statistics window by query type; upstream trims to the top ten",
          labelNames: ["query_type"],
          registers,
        })
      : undefined,
    windowSeconds: new AbsentUntilSetGauge(
      registry,
      "technitium_stats_window_seconds",
      "Length in seconds of the statistics window the other technitium_stats_window_* gauges cover",
    ),
    zonesReported: new AbsentUntilSetGauge(
      registry,
      "technitium_zones_reported",
      "The server's own authoritative zone total, unfiltered by per-zone View permission (D§5.3)",
    ),
    liveState,
    collectorSuccess,
    unknownEnum,
  };
}

// Clears every series this collector owns to genuinely absent, not zero:
// like zone-metrics.ts's applyZoneFailure, these are live snapshots of
// current server state, not lifetime totals, so a transient poll failure
// must not leave stale numbers standing in for the current window/state.
export function applyStatsFailure(metrics: StatsMetrics): void {
  metrics.queriesByProtocol.reset();
  metrics.queriesByResponseType.reset();
  metrics.queryTypes?.reset();
  metrics.windowSeconds.clear();
  metrics.zonesReported.clear();
  for (const field of liveStateFields()) metrics.liveState[field].clear();
  metrics.collectorSuccess.labels({ collector: "stats" }).set(0);
}

export function applyStatsSuccess(metrics: StatsMetrics, detail: StatsWindowDetail): void {
  metrics.queriesByProtocol.reset();
  for (const protocol of PROTOCOLS) {
    metrics.queriesByProtocol.labels({ protocol }).set(detail.queriesByProtocol.get(protocol) ?? 0);
  }
  recordUnrecognized(metrics.unknownEnum, "stats_protocol", PROTOCOLS, detail.queriesByProtocol);

  metrics.queriesByResponseType.reset();
  for (const responseType of RESPONSE_TYPES) {
    metrics.queriesByResponseType
      .labels({ response_type: responseType })
      .set(detail.queriesByResponseType.get(responseType) ?? 0);
  }
  recordUnrecognized(
    metrics.unknownEnum,
    "stats_response_type",
    RESPONSE_TYPES,
    detail.queriesByResponseType,
  );

  if (metrics.queryTypes !== undefined) {
    metrics.queryTypes.reset();
    for (const [queryType, count] of detail.queryTypes) {
      metrics.queryTypes.labels({ query_type: queryType }).set(count);
    }
  }

  metrics.windowSeconds.set(STATS_WINDOW_SECONDS);
  metrics.zonesReported.setOrClear(detail.zonesReported);
  for (const field of liveStateFields()) metrics.liveState[field].setOrClear(detail[field]);

  metrics.collectorSuccess.labels({ collector: "stats" }).set(1);
}
