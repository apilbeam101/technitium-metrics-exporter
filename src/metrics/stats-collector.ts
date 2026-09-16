import type { Counter, Gauge, Registry } from "@prometheus-io/client";
import { parseStatsGetResponse, type StatsWindowDetail } from "../api/stats.ts";
import type { HttpClient } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import { createRefreshCache, type RefreshCache } from "../poller/refresh-cache.ts";
import {
  applyStatsFailure,
  applyStatsSuccess,
  createStatsMetrics,
  type StatsMetrics,
} from "./stats-metrics.ts";

const STATS_GET_PATH = "/api/dashboard/stats/get";

// D§3.2.6: stats/get resolves reverse DNS for its top-clients list on every
// call, whether or not this exporter reads that list — the reason this
// collector runs on its own slower cadence (config/validate.ts's
// STATS_POLL_INTERVAL_SECONDS, enforced there at a 60-second floor) via
// refresh-cache.ts's primitive, the same as ClusterCollector, rather than on
// TargetPoller's main cadence.
const EMPTY_DETAIL: StatsWindowDetail = {
  queriesByProtocol: new Map(),
  queriesByResponseType: new Map(),
  queryTypes: new Map(),
  zonesReported: undefined,
  cachedEntries: undefined,
  allowedZones: undefined,
  blockedZones: undefined,
  allowListZones: undefined,
  blockListZones: undefined,
};

export interface StatsCollectorOptions {
  readonly httpClient: Pick<HttpClient, "get">;
  readonly registry: Registry;
  // Created by session-metrics.ts and passed in, same reason
  // native-collector.ts's own collectorSuccess option is.
  readonly collectorSuccess: Gauge<"collector">;
  readonly unknownEnum: Counter<"metric" | "value">;
  // Mirrors ENABLE_STATS_QUERY_TYPES (D§6.2): off by default, since upstream
  // trims queryTypeChartData to its own top ten and the label set churns.
  readonly includeQueryTypes: boolean;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly warn: (message: string) => void;
}

export type StatsCollectResult =
  | { readonly kind: "success"; readonly fresh: boolean }
  | { readonly kind: "failure"; readonly reason: PollErrorReason; readonly fresh: boolean };

type FetchOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

// D§5.5: the protocol/response-type/query-type window split plus the D§5.3
// zones_reported cross-check and D§5.5's live cache/blocklist gauges, all
// opt-in behind ENABLE_STATS_COLLECTOR (D§4.2) — off by default because
// stats/get has the reverse-DNS side effect noted above.
export class StatsCollector {
  readonly #httpClient: Pick<HttpClient, "get">;
  readonly #metrics: StatsMetrics;
  readonly #refreshCache: RefreshCache<StatsWindowDetail>;
  readonly #warn: (message: string) => void;
  // Same "last real attempt vs. this cycle's own restatement" split
  // ClusterCollector uses, for the same off-cadence-cycle reason.
  #lastOutcome: FetchOutcome = { kind: "failure", reason: "unknown" };
  #wasFailing = false;

  constructor(options: StatsCollectorOptions) {
    this.#httpClient = options.httpClient;
    this.#metrics = createStatsMetrics(
      options.registry,
      options.collectorSuccess,
      options.unknownEnum,
      options.includeQueryTypes,
    );
    this.#warn = options.warn;
    this.#refreshCache = createRefreshCache<StatsWindowDetail>({
      clock: options.clock,
      intervalMs: options.intervalMs,
      initialValue: EMPTY_DETAIL,
      fetch: async () => {
        // Explicit rather than relying on upstream's own LastHour default
        // (dash.cs's GetStatsAsync), so stats-metrics.ts's fixed
        // STATS_WINDOW_SECONDS constant stays true regardless of any future
        // upstream default change.
        const body = (await this.#httpClient.get(STATS_GET_PATH, { type: "LastHour" })).body;
        const detail = parseStatsGetResponse(body);
        this.#lastOutcome = { kind: "success" };
        this.#wasFailing = false;
        return detail;
      },
      onFailure: (error) => this.#recordFailure(error),
    });
  }

  async collect(): Promise<StatsCollectResult> {
    // fresh distinguishes a cycle that actually attempted a fetch from one
    // merely restating the last attempt's outcome because the interval
    // hasn't elapsed yet, the same reason ClusterCollector.collect() reports
    // it — a caller must only count a parse failure once per real attempt.
    const fresh = await this.#refreshCache.refreshIfDue();

    if (this.#lastOutcome.kind === "failure") {
      applyStatsFailure(this.#metrics);
      return { kind: "failure", reason: this.#lastOutcome.reason, fresh };
    }

    applyStatsSuccess(this.#metrics, this.#refreshCache.getCached());
    return { kind: "success", fresh };
  }

  // Warns once on the transition into failure, the same "state persists
  // across calls" shape session-collector.ts's own #fail() uses.
  #recordFailure(error: unknown): void {
    const reason = reasonOfError(error);
    this.#lastOutcome = { kind: "failure", reason };
    if (!this.#wasFailing) {
      const message = error instanceof Error ? error.message : String(error);
      this.#warn(`stats collector failed (${reason}): ${message}`);
      this.#wasFailing = true;
    }
  }
}
