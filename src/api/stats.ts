import { TechnitiumHttpError } from "../http/errors.ts";
import { assertOk, classifyEnvelope } from "./envelope.ts";

// D§5.5's table: labels/data are positionally zipped (D§3.2.6), and this
// parser only ever produces a map of whatever labels the response actually
// carried — zero-filling the five recognized protocols/response types
// against that map, and counting an unrecognized one, are both
// classification concerns that belong to stats-metrics.ts, not here.
export interface StatsWindowDetail {
  readonly queriesByProtocol: ReadonlyMap<string, number>;
  readonly queriesByResponseType: ReadonlyMap<string, number>;
  // Upstream trims this to its own top ten by hit count (D§5.5), so unlike
  // the other two charts there is no fixed recognized set to zero-fill or
  // classify against — this map is exported as-is, gated by
  // ENABLE_STATS_QUERY_TYPES.
  readonly queryTypes: ReadonlyMap<string, number>;
  // D§5.3's cross-check target: the server's own authoritative zone total,
  // independent of the per-zone View filtering zones/list applies.
  readonly zonesReported: number | undefined;
  // D§5.5's "live current state" fields, read from the zone/cache managers
  // at request time rather than derived from the window — named without
  // "window" downstream for exactly that reason.
  readonly cachedEntries: number | undefined;
  readonly allowedZones: number | undefined;
  readonly blockedZones: number | undefined;
  readonly allowListZones: number | undefined;
  readonly blockListZones: number | undefined;
}

interface RawChartData {
  readonly labels?: unknown[];
  readonly datasets?: Array<{ readonly data?: unknown[] }>;
}

interface RawStats {
  readonly zones?: number;
  readonly cachedEntries?: number;
  readonly allowedZones?: number;
  readonly blockedZones?: number;
  readonly allowListZones?: number;
  readonly blockListZones?: number;
}

// dashboardStats.Stats also carries totalQueries/totalNoError/etc
// (dash.cs) — the same eleven lifetime counters D§5.4 already sources from
// metrics/text. Reading them here too would give this exporter two sources
// of truth for one counter, so this interface has no field for them at all:
// never read, so never at risk of silently drifting from the native
// collector's own values.
interface RawStatsGet {
  readonly stats?: RawStats;
  readonly protocolTypeChartData?: RawChartData;
  readonly queryResponseChartData?: RawChartData;
  readonly queryTypeChartData?: RawChartData;
}

// D§9.1/IMPLEMENTATION Phase 9 exit criterion: a labels/data length mismatch
// is a parse error, not a silently misaligned series built by zipping past
// the shorter array.
function zipChart(context: string, chart: RawChartData | undefined): Map<string, number> {
  const labels = chart?.labels ?? [];
  const data = chart?.datasets?.[0]?.data ?? [];
  if (labels.length !== data.length) {
    throw new TechnitiumHttpError(
      "parse",
      `dashboard/stats/get: ${context} labels/data length mismatch`,
    );
  }

  const zipped = new Map<string, number>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const value = data[i];
    if (typeof label !== "string" || typeof value !== "number") {
      throw new TechnitiumHttpError(
        "parse",
        `dashboard/stats/get: ${context} has a non-string label or non-numeric value`,
      );
    }
    zipped.set(label, value);
  }
  return zipped;
}

// D§3.2.14: stats/get wraps its payload under `response`, the same shape as
// zones/list and admin/cluster/state.
export function parseStatsGetResponse(rawBody: string): StatsWindowDetail {
  const response = assertOk(
    classifyEnvelope<RawStatsGet>(rawBody, "wrapped"),
    "dashboard/stats/get",
  );

  return {
    queriesByProtocol: zipChart("protocolTypeChartData", response.protocolTypeChartData),
    queriesByResponseType: zipChart("queryResponseChartData", response.queryResponseChartData),
    queryTypes: zipChart("queryTypeChartData", response.queryTypeChartData),
    zonesReported: response.stats?.zones,
    cachedEntries: response.stats?.cachedEntries,
    allowedZones: response.stats?.allowedZones,
    blockedZones: response.stats?.blockedZones,
    allowListZones: response.stats?.allowListZones,
    blockListZones: response.stats?.blockListZones,
  };
}
