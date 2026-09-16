import type { Gauge, Registry } from "@prometheus-io/client";
import { type ClusterConfigDetail, parseClusterStateResponse } from "../api/cluster.ts";
import type { HttpClient } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import { createRefreshCache, type RefreshCache } from "../poller/refresh-cache.ts";
import {
  applyClusterConfigFailure,
  applyClusterConfigNotClustered,
  applyClusterConfigSuccess,
  type ClusterMetrics,
  createClusterMetrics,
} from "./cluster-metrics.ts";

const CLUSTER_STATE_PATH = "/api/admin/cluster/state";

// Never actually observed: refreshIfDue() always fetches on its first call
// (refresh-cache.ts's lastStartedAt starts undefined), so by the time
// collect() first reads #lastOutcome/getCached() it has always been
// overwritten by that first attempt. Required only because
// createRefreshCache()'s initialValue and the #lastOutcome field both need
// some starting value.
const EMPTY_DETAIL: ClusterConfigDetail = {
  heartbeatRefreshIntervalSeconds: undefined,
  heartbeatRetryIntervalSeconds: undefined,
  configRefreshIntervalSeconds: undefined,
  configLastSyncedSeconds: undefined,
};

export interface ClusterCollectorOptions {
  readonly httpClient: Pick<HttpClient, "get">;
  readonly registry: Registry;
  // Created by session-metrics.ts and passed in, same reason
  // native-collector.ts's own collectorSuccess option is.
  readonly collectorSuccess: Gauge<"collector">;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly warn: (message: string) => void;
}

export type ClusterCollectResult =
  | { readonly kind: "success"; readonly fresh: boolean }
  | { readonly kind: "failure"; readonly reason: PollErrorReason; readonly fresh: boolean };

type FetchOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

// D§5.6: the four cluster-configuration-detail metrics that need
// Administration: View and admin/cluster/state, on their own slower cadence
// (D§4.2) via refresh-cache.ts's primitive — the peer state set itself is
// Phase 4's, from session/get, with no permission and no cadence of its own.
export class ClusterCollector {
  readonly #metrics: ClusterMetrics;
  readonly #refreshCache: RefreshCache<ClusterConfigDetail>;
  readonly #warn: (message: string) => void;
  // Tracks the outcome of the last actual fetch attempt, distinct from
  // whether *this* collect() call triggered one: refreshIfDue() is a no-op
  // on a cycle where the interval hasn't elapsed, and this collector's
  // reported outcome for that cycle must still reflect the last real attempt
  // rather than some default.
  #lastOutcome: FetchOutcome = { kind: "failure", reason: "unknown" };
  #wasFailing = false;

  constructor(options: ClusterCollectorOptions) {
    this.#metrics = createClusterMetrics(options.registry, options.collectorSuccess);
    this.#warn = options.warn;
    this.#refreshCache = createRefreshCache<ClusterConfigDetail>({
      clock: options.clock,
      intervalMs: options.intervalMs,
      initialValue: EMPTY_DETAIL,
      fetch: async () => {
        const body = (await options.httpClient.get(CLUSTER_STATE_PATH)).body;
        const detail = parseClusterStateResponse(body);
        this.#lastOutcome = { kind: "success" };
        this.#wasFailing = false;
        return detail;
      },
      onFailure: (error) => this.#recordFailure(error),
    });
  }

  async collect(): Promise<ClusterCollectResult> {
    // fresh distinguishes a cycle that actually attempted a fetch from one
    // that's merely restating the last attempt's outcome because the
    // interval hasn't elapsed yet — a caller must only count a parse
    // failure (hadParseError, technitium_exporter_poll_errors_total) once
    // per real attempt, not once per poll cycle until the next fetch.
    const fresh = await this.#refreshCache.refreshIfDue();

    if (this.#lastOutcome.kind === "failure") {
      applyClusterConfigFailure(this.#metrics);
      return { kind: "failure", reason: this.#lastOutcome.reason, fresh };
    }

    applyClusterConfigSuccess(this.#metrics, this.#refreshCache.getCached());
    return { kind: "success", fresh };
  }

  // Called instead of collect() for a cycle where the target isn't
  // clustered (or the permission is missing): never fetches, and clears
  // every series this collector owns rather than freezing them, since a
  // target with no cluster has no cluster configuration to report at all —
  // see cluster-metrics.ts's applyClusterConfigNotClustered.
  notClustered(): void {
    applyClusterConfigNotClustered(this.#metrics);
  }

  // Warns once on the transition into failure, the same "state persists
  // across calls" shape session-collector.ts's own #fail() uses.
  #recordFailure(error: unknown): void {
    const reason = reasonOfError(error);
    this.#lastOutcome = { kind: "failure", reason };
    if (!this.#wasFailing) {
      const message = error instanceof Error ? error.message : String(error);
      this.#warn(`cluster collector failed (${reason}): ${message}`);
      this.#wasFailing = true;
    }
  }
}
