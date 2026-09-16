import { Registry } from "@prometheus-io/client";
import type { AppConfig, TargetConfig } from "../config/types.ts";
import { createAgent } from "../http/agent.ts";
import { HttpClient } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import { NativeCollector } from "../metrics/native-collector.ts";
import { SessionCollector } from "../metrics/session-collector.ts";
import { ZoneCollector } from "../metrics/zone-collector.ts";
import { PollCycleTracker } from "./cache.ts";
import { TargetPoller } from "./target-poller.ts";

// The two enabled-here collectors' own required permission sections
// (session-collector.ts's internal COLLECTOR_PERMISSION_REQUIREMENTS table
// isn't exported, so this mirrors just the "native"/"zones" rows of it —
// deliberately not "cluster"/"stats", whose collectors don't exist until
// Phases 8-9).
const NATIVE_PERMISSION_SECTION = "Dashboard";
const ZONES_PERMISSION_SECTION = "Zones";

function defaultHttpClient(target: TargetConfig, config: AppConfig, clock: Clock): HttpClient {
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
}

export interface TargetCycleResult {
  readonly summary: CycleSummary;
  readonly hadParseError: boolean;
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
  const { session, native, zones } = collectors;
  const sessionResult = await session.collect();

  let nativeOutcome: CycleSummary["native"] = "skipped";
  let zoneOutcome: CycleSummary["zones"] = "skipped";
  let hadParseError = sessionResult.kind === "failure" && sessionResult.reason === "parse";

  if (sessionResult.kind === "success") {
    const { permissions } = sessionResult.info;
    const tasks: Array<Promise<void>> = [];

    if (permissions[NATIVE_PERMISSION_SECTION]?.canView) {
      tasks.push(
        native.collect().then((result) => {
          nativeOutcome = result.kind;
          if (result.kind === "failure" && result.reason === "parse") hadParseError = true;
        }),
      );
    }

    if (permissions[ZONES_PERMISSION_SECTION]?.canView) {
      tasks.push(
        zones.collect().then((result) => {
          zoneOutcome = result.kind;
          if (result.kind === "failure" && result.reason === "parse") hadParseError = true;
        }),
      );
    }

    await Promise.all(tasks);
  } else {
    session.collectorSuccess.labels({ collector: "native" }).set(0);
    session.collectorSuccess.labels({ collector: "zones" }).set(0);
  }

  return {
    summary: { session: sessionResult.kind, native: nativeOutcome, zones: zoneOutcome },
    hadParseError,
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
  // server or a mock HTTP listener.
  readonly createHttpClient?: (target: TargetConfig) => Pick<HttpClient, "get">;
}

// Holds one Registry + HttpClient + collector set + TargetPoller per
// configured target (D§4.4): the isolation, correct series disappearance,
// and per-target failure state that model depends on all come from each
// target getting its own instance of everything here, never a shared one.
export class TargetRegistry {
  readonly #entries: ReadonlyMap<string, TargetEntry>;

  constructor(config: AppConfig, options: TargetRegistryOptions) {
    const createHttpClient =
      options.createHttpClient ?? ((target) => defaultHttpClient(target, config, options.clock));

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
  createHttpClient: (target: TargetConfig) => Pick<HttpClient, "get">,
): TargetEntry {
  const registry = new Registry();
  const httpClient = createHttpClient(target);

  const session = new SessionCollector({
    httpClient,
    registry,
    enabledCollectors: ["native", "zones"],
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

  const pollTracker = new PollCycleTracker<CycleSummary>();

  const runCycle = async (): Promise<void> => {
    const { summary, hadParseError } = await runTargetCycle({ session, native, zones });
    // Monotonic, per IMPLEMENTATION.md's "Shared primitives": clock.now()
    // (Date.now()) would step backwards or jump under an NTP correction,
    // fabricating a negative or bogus cache age once Phase 10 exposes this.
    pollTracker.record(summary, options.clock.elapsed(), hadParseError);
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
