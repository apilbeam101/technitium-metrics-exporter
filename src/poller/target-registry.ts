import { Registry } from "@prometheus-io/client";
import type { AppConfig, TargetConfig } from "../config/types.ts";
import { createAgent } from "../http/agent.ts";
import { HttpClient, type OnUpstreamAttempt } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import type { PollErrorReason } from "../http/errors.ts";
import { ClusterCollector } from "../metrics/cluster-collector.ts";
import { NativeCollector } from "../metrics/native-collector.ts";
import { SessionCollector } from "../metrics/session-collector.ts";
import { StatsCollector } from "../metrics/stats-collector.ts";
import { ZoneCollector } from "../metrics/zone-collector.ts";
import { PollCycleTracker } from "./cache.ts";
import { SelfMetrics } from "./self-metrics.ts";
import { TargetPoller } from "./target-poller.ts";

// These four enabled-here collectors' own required permission sections
// (session-collector.ts's internal COLLECTOR_PERMISSION_REQUIREMENTS table
// isn't exported, so this mirrors those rows of it).
const NATIVE_PERMISSION_SECTION = "Dashboard";
const ZONES_PERMISSION_SECTION = "Zones";
const STATS_PERMISSION_SECTION = "Dashboard";
const CLUSTER_PERMISSION_SECTION = "Administration";

function defaultHttpClient(
  target: TargetConfig,
  config: AppConfig,
  clock: Clock,
  onUpstreamAttempt: OnUpstreamAttempt,
): HttpClient {
  const dispatcher = createAgent({
    caBundlePath: target.caBundlePath,
    tlsInsecureSkipVerify: target.tlsInsecureSkipVerify,
  });
  return new HttpClient({
    baseUrl: target.baseUrl,
    apiToken: target.apiToken,
    dispatcher,
    clock,
    budgetMs: config.requestTimeoutSeconds * 1000,
    onUpstreamAttempt,
  });
}

// Concurrent scrapes of the same target must share one in-flight render
// rather than each triggering its own registry.metrics() pass — the
// Registry itself has no such guard.
class SingleFlightRenderer {
  readonly #registry: Registry;
  #inFlight: Promise<string> | undefined;

  constructor(registry: Registry) {
    this.#registry = registry;
  }

  render(): Promise<string> {
    this.#inFlight ??= this.#registry.metrics().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }
}

export interface CycleSummary {
  readonly session: "success" | "failure";
  readonly native: "success" | "failure" | "skipped";
  readonly zones: "success" | "failure" | "skipped";
  readonly stats: "success" | "failure" | "skipped";
  readonly cluster: "success" | "failure" | "skipped";
}

// Narrowed to just the .labels(...).set(...) shape runTargetCycle actually
// calls, rather than the full Gauge<"collector">, so a test can supply a
// minimal fake session collector without implementing every Gauge method.
export interface CollectorSuccessWriter {
  labels(labels: { collector: string }): { set(value: number): void };
}

export interface TargetCollectors {
  readonly session: Pick<SessionCollector, "collect"> & {
    readonly collectorSuccess: CollectorSuccessWriter;
  };
  readonly native: Pick<NativeCollector, "collect">;
  readonly zones: Pick<ZoneCollector, "collect">;
  // Absent when ENABLE_STATS_COLLECTOR is off (D§4.2's default), unlike
  // native/zones, which have no such opt-out flag.
  readonly stats?: Pick<StatsCollector, "collect"> | undefined;
  // Absent when ENABLE_CLUSTER_COLLECTOR is off (D§4.2's default), unlike
  // native/zones, which have no such opt-out flag.
  readonly cluster?: Pick<ClusterCollector, "collect" | "notClustered"> | undefined;
}

export interface TargetCycleResult {
  readonly summary: CycleSummary;
  readonly hadParseError: boolean;
  // One entry per real failed attempt this cycle (session always; native/
  // zones whenever attempted; stats/cluster only when `fresh`, the same
  // gating hadParseError already applies to those two) — self-metrics.ts's
  // technitium_exporter_poll_errors_total{reason} increments once per entry.
  readonly pollErrorReasons: readonly PollErrorReason[];
  // Which collector groups had a fresh parse failure this cycle, for
  // technitium_exporter_parse_errors_total{group} — a superset-free subset of
  // pollErrorReasons: every group here also contributed a "parse" entry
  // above, but pollErrorReasons doesn't say which collector a given reason
  // came from.
  readonly parseErrorGroups: readonly string[];
}

// The one thing every poll cycle actually does, kept independent of
// TargetPoller's own scheduling so it's directly awaitable in a test with
// no clock or timer involved at all — the same "when to poll" vs. "what a
// cycle does" split refresh-cache.ts's refreshIfDue()/getCached() makes.
// SessionCollector.collect() runs first and its own permission map decides
// whether native/zones are even attempted this cycle: a missing grant skips
// the call entirely (session-collector.ts already marks that collector's
// technitium_collector_success 0 and warns once), and a failed session call
// means the node itself is unreachable or the token was rejected, so
// native/zones never get a chance to try — their own success series must
// read 0 too rather than freezing at whatever they last reported (N6).
export async function runTargetCycle(collectors: TargetCollectors): Promise<TargetCycleResult> {
  const { session, native, zones, stats, cluster } = collectors;
  const sessionResult = await session.collect();

  let nativeOutcome: CycleSummary["native"] = "skipped";
  let zoneOutcome: CycleSummary["zones"] = "skipped";
  let statsOutcome: CycleSummary["stats"] = "skipped";
  let clusterOutcome: CycleSummary["cluster"] = "skipped";
  const pollErrorReasons: PollErrorReason[] = [];
  const parseErrorGroups: string[] = [];

  if (sessionResult.kind === "failure") {
    pollErrorReasons.push(sessionResult.reason);
    if (sessionResult.reason === "parse") parseErrorGroups.push("session");
  }

  if (sessionResult.kind === "success") {
    const { permissions } = sessionResult.info;
    const tasks: Array<Promise<void>> = [];

    if (permissions[NATIVE_PERMISSION_SECTION]?.canView) {
      tasks.push(
        native.collect().then((result) => {
          nativeOutcome = result.kind;
          if (result.kind === "failure") {
            pollErrorReasons.push(result.reason);
            if (result.reason === "parse") parseErrorGroups.push("native");
          }
        }),
      );
    }

    if (permissions[ZONES_PERMISSION_SECTION]?.canView) {
      tasks.push(
        zones.collect().then((result) => {
          zoneOutcome = result.kind;
          if (result.kind === "failure") {
            pollErrorReasons.push(result.reason);
            if (result.reason === "parse") parseErrorGroups.push("zones");
          }
        }),
      );
    }

    if (stats !== undefined && permissions[STATS_PERMISSION_SECTION]?.canView) {
      tasks.push(
        stats.collect().then((result) => {
          statsOutcome = result.kind;
          // Only a fresh attempt's own outcome counts — an off-cadence cycle
          // just restates the last real attempt's outcome and must not
          // re-count it on every such cycle until the next actual fetch
          // (D§5.7), the same reason cluster's own handling below checks
          // result.fresh.
          if (result.fresh && result.kind === "failure") {
            pollErrorReasons.push(result.reason);
            if (result.reason === "parse") parseErrorGroups.push("stats");
          }
        }),
      );
    }

    if (cluster !== undefined) {
      if (
        sessionResult.info.clusterInitialized &&
        permissions[CLUSTER_PERMISSION_SECTION]?.canView
      ) {
        tasks.push(
          cluster.collect().then((result) => {
            clusterOutcome = result.kind;
            // Only a fresh attempt's own outcome counts — an off-cadence
            // cycle just restates the last real attempt's outcome and must
            // not re-count it on every such cycle until the next actual
            // fetch (D§5.7).
            if (result.fresh && result.kind === "failure") {
              pollErrorReasons.push(result.reason);
              if (result.reason === "parse") parseErrorGroups.push("cluster");
            }
          }),
        );
      } else if (!sessionResult.info.clusterInitialized) {
        // admin/cluster/state has nothing cluster-shaped to report for a
        // standalone node, so this clears the four value fields and
        // collector_success's own "cluster" child rather than either
        // calling the endpoint forever or leaving them frozen at whatever
        // they last reported while clustered — the same "no cluster claims
        // to make" reasoning session-metrics.ts's own
        // applyClusterPeers(metrics, undefined) uses. A missing
        // Administration: View grant on an otherwise-clustered target is
        // deliberately not handled here: session-collector.ts's own
        // permission-gating loop already zeroes collector_success{cluster}
        // and warns once for that case (D§4.4), which is the correct signal
        // — unlike this one, it isn't reporting false health.
        cluster.notClustered();
      }
    }

    await Promise.all(tasks);
  } else {
    session.collectorSuccess.labels({ collector: "native" }).set(0);
    session.collectorSuccess.labels({ collector: "zones" }).set(0);
    if (stats !== undefined) session.collectorSuccess.labels({ collector: "stats" }).set(0);
    if (cluster !== undefined) session.collectorSuccess.labels({ collector: "cluster" }).set(0);
  }

  return {
    summary: {
      session: sessionResult.kind,
      native: nativeOutcome,
      zones: zoneOutcome,
      stats: statsOutcome,
      cluster: clusterOutcome,
    },
    hadParseError: parseErrorGroups.length > 0,
    pollErrorReasons,
    parseErrorGroups,
  };
}

export interface TargetEntry {
  readonly name: string;
  readonly registry: Registry;
  readonly poller: TargetPoller;
  readonly pollTracker: PollCycleTracker<CycleSummary>;
  // Exposed alongside poller (rather than only reachable through it) so a
  // test can await exactly one cycle directly, with no clock or timer in
  // the loop at all.
  runCycle(): Promise<void>;
  renderMetrics(): Promise<string>;
}

export interface TargetRegistryOptions {
  readonly clock: Clock;
  readonly warn: (targetName: string, message: string) => void;
  // Overridable so tests can inject a fake HttpClient (per the pattern every
  // collector already supports) instead of standing up a real Technitium
  // server or a mock HTTP listener. onUpstreamAttempt is passed through so a
  // test-supplied client can still be wired into that target's own
  // self-metrics if it wants to (most tests ignore the second parameter,
  // which TypeScript allows a function value to do).
  readonly createHttpClient?: (
    target: TargetConfig,
    onUpstreamAttempt: OnUpstreamAttempt,
  ) => Pick<HttpClient, "get">;
}

// Holds one Registry + HttpClient + collector set + TargetPoller per
// configured target (D§4.4): the isolation, correct series disappearance,
// and per-target failure state that model depends on all come from each
// target getting its own instance of everything here, never a shared one.
export class TargetRegistry {
  readonly #entries: ReadonlyMap<string, TargetEntry>;

  constructor(config: AppConfig, options: TargetRegistryOptions) {
    const createHttpClient =
      options.createHttpClient ??
      ((target, onUpstreamAttempt) =>
        defaultHttpClient(target, config, options.clock, onUpstreamAttempt));

    const entries = new Map<string, TargetEntry>();
    for (const target of config.targets) {
      entries.set(target.name, buildEntry(target, config, options, createHttpClient));
    }
    this.#entries = entries;
  }

  get(name: string): TargetEntry | undefined {
    return this.#entries.get(name);
  }

  get names(): readonly string[] {
    return [...this.#entries.keys()];
  }

  startAll(): void {
    for (const entry of this.#entries.values()) entry.poller.start();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.poller.stop()));
  }

  // Backs /readyz (N3): a target that is permanently down still counts as
  // "completed" once its first cycle has run and failed, so one dead node
  // can never hold every other target's own readiness hostage.
  get allTargetsReady(): boolean {
    if (this.#entries.size === 0) return true;
    return [...this.#entries.values()].every((entry) => entry.pollTracker.hasCompletedCycle);
  }
}

function buildEntry(
  target: TargetConfig,
  config: AppConfig,
  options: TargetRegistryOptions,
  createHttpClient: (
    target: TargetConfig,
    onUpstreamAttempt: OnUpstreamAttempt,
  ) => Pick<HttpClient, "get">,
): TargetEntry {
  const registry = new Registry();
  const pollTracker = new PollCycleTracker<CycleSummary>();
  const selfMetrics = new SelfMetrics(registry, {
    clock: options.clock,
    tlsInsecureSkipVerify: target.tlsInsecureSkipVerify,
    pollTracker,
  });
  const httpClient = createHttpClient(target, (outcome) =>
    selfMetrics.recordUpstreamAttempt(outcome),
  );

  const enabledCollectors: string[] = ["native", "zones"];
  if (config.enableStatsCollector) enabledCollectors.push("stats");
  if (config.enableClusterCollector) enabledCollectors.push("cluster");

  const session = new SessionCollector({
    httpClient,
    registry,
    enabledCollectors,
    warn: (message) => options.warn(target.name, message),
  });
  const native = new NativeCollector({
    httpClient,
    registry,
    collectorSuccess: session.collectorSuccess,
  });
  const zones = new ZoneCollector({
    httpClient,
    registry,
    collectorSuccess: session.collectorSuccess,
    unknownEnum: session.unknownEnum,
    includeInternal: config.zonesIncludeInternal,
  });
  const stats = config.enableStatsCollector
    ? new StatsCollector({
        httpClient,
        registry,
        collectorSuccess: session.collectorSuccess,
        unknownEnum: session.unknownEnum,
        includeQueryTypes: config.enableStatsQueryTypes,
        clock: options.clock,
        intervalMs: config.statsPollIntervalSeconds * 1000,
        warn: (message) => options.warn(target.name, message),
      })
    : undefined;
  const cluster = config.enableClusterCollector
    ? new ClusterCollector({
        httpClient,
        registry,
        collectorSuccess: session.collectorSuccess,
        clock: options.clock,
        intervalMs: config.clusterPollIntervalSeconds * 1000,
        warn: (message) => options.warn(target.name, message),
      })
    : undefined;

  const runCycle = async (): Promise<void> => {
    const startedAtElapsedMs = options.clock.elapsed();
    const { summary, hadParseError, pollErrorReasons, parseErrorGroups } = await runTargetCycle({
      session,
      native,
      zones,
      stats,
      cluster,
    });
    // Monotonic, per IMPLEMENTATION.md's "Shared primitives": clock.now()
    // (Date.now()) would step backwards or jump under an NTP correction,
    // fabricating a negative or bogus cache age.
    const finishedAtElapsedMs = options.clock.elapsed();

    pollTracker.record(summary, finishedAtElapsedMs, hadParseError);

    selfMetrics.recordPollCycle(
      summary.session === "success" ? "success" : "failure",
      finishedAtElapsedMs - startedAtElapsedMs,
    );
    for (const reason of pollErrorReasons) selfMetrics.recordPollError(reason);
    for (const group of parseErrorGroups) selfMetrics.recordParseError(group);
    // Unconditional, the same way pollTracker.record() above is: what's
    // cached is whatever this cycle produced, whether or not it succeeded.
    // Must run after pollTracker.record() above — noteCacheFetch() only
    // arms cache_age_seconds's presence; the fetchedAt value it reports is
    // read directly from pollTracker.lastEntry at collect time.
    selfMetrics.noteCacheFetch();
  };

  const poller = new TargetPoller({
    clock: options.clock,
    pollIntervalMs: config.pollIntervalSeconds * 1000,
    runCycle,
  });

  const renderer = new SingleFlightRenderer(registry);

  return {
    name: target.name,
    registry,
    poller,
    pollTracker,
    runCycle,
    renderMetrics: () => renderer.render(),
  };
}
