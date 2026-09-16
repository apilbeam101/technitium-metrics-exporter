import {
  Counter,
  exponentialBuckets,
  Gauge,
  Histogram,
  type Registry,
} from "@prometheus-io/client";
import type { UpstreamAttemptOutcome } from "../http/client.ts";
import type { Clock } from "../http/clock.ts";
import type { PollErrorReason } from "../http/errors.ts";
import { AbsentUntilSetGauge } from "../metrics/absent-gauge.ts";

// Covers a single upstream call (bounded by REQUEST_TIMEOUT_SECONDS, default
// 15s) and a whole poll cycle (several such calls, some in parallel) with one
// shared bucket scheme, from 5ms up to ~80s — generous at the top end because
// REQUEST_TIMEOUT_SECONDS is operator-configurable up to 3600s (D§6.2) and
// this can't size itself to an unknown deployment's own value. Histogram
// (rather than Summary) is the Prometheus convention for a duration a
// dashboard or alert wants to aggregate with histogram_quantile()/rate()
// across targets — a Summary's quantiles are calculated client-side and
// cannot be aggregated after the fact.
const DURATION_SECONDS_BUCKETS = exponentialBuckets(0.005, 2, 15);

// The slice of a concrete Metric's real runtime shape this file needs from
// Registry.getMetricsAsArray()'s own elements — that method's declared
// return type (MetricObject[]) omits .get() even though every concrete
// Counter/Gauge/Histogram/Summary has it (registry.js's own
// getMetricsAsJSON() relies on exactly this to build its output).
interface MetricWithGet {
  readonly name: string;
  get(): Promise<{ readonly values?: ReadonlyArray<unknown> }>;
}

// Narrowed to just what cache_age_seconds's own collect callback needs from
// PollCycleTracker's own lastEntry — pulling in the full generic type would
// force this file to also know CycleSummary's shape, which it has no other
// reason to import.
export interface CacheFetchSource {
  readonly lastEntry: { readonly fetchedAt: number } | undefined;
}

export interface SelfMetricsOptions {
  readonly clock: Clock;
  readonly tlsInsecureSkipVerify: boolean;
  readonly pollTracker: CacheFetchSource;
}

// D§5.7's per-target exporter self-observability surface. Every metric here
// describes the exporter's own behaviour towards one target, never the DNS
// node's own state (that's every other *-metrics.ts file) — so, unlike them,
// there is no applyXSuccess/applyXFailure pair driven by one upstream
// response: a poll cycle here is several independent events (the cycle
// itself, each collector's own outcome, each individual upstream HTTP
// attempt) recorded as they happen rather than applied all at once from a
// single parsed payload.
export class SelfMetrics {
  readonly lastSuccessfulPollTimestampSeconds: Gauge;
  readonly cacheAgeSeconds: AbsentUntilSetGauge;
  readonly pollTotal: Counter;
  readonly pollErrorsTotal: Counter<"reason">;
  readonly pollDurationSeconds: Histogram;
  readonly upstreamRequestsTotal: Counter<"endpoint" | "status_code">;
  readonly upstreamRequestDurationSeconds: Histogram<"endpoint">;
  readonly parseErrorsTotal: Counter<"group">;
  readonly series: Gauge;
  readonly tlsVerificationDisabled: Gauge;

  readonly #clock: Clock;

  constructor(registry: Registry, options: SelfMetricsOptions) {
    this.#clock = options.clock;
    const { pollTracker } = options;
    const registers = [registry];
    const seriesMetricName = "technitium_exporter_series";

    this.lastSuccessfulPollTimestampSeconds = new Gauge({
      name: "technitium_exporter_last_successful_poll_timestamp_seconds",
      help: "Unix time this target's poll cycle last reached the node and its session call succeeded",
      registers,
    });

    // Genuinely absent (no series at all) until this target's first poll
    // cycle completes — AbsentUntilSetGauge's own ensurePresent() below is
    // called no earlier than pollTracker.record() for the same cycle
    // (target-registry.ts's buildEntry), so lastEntry is guaranteed defined
    // by the time this collect callback ever actually runs; the
    // `?? this.#clock.elapsed()` fallback below only satisfies the type
    // checker/linter, it can't actually be reached — if it ever were, it
    // would yield a cache age of 0 seconds, not a thrown error. D§5.7:
    // computed at collect time from the monotonic clock, not updated on a
    // timer — a render five minutes after the last poll must report a
    // five-minute-old cache even though nothing "wrote" to this gauge in
    // between. Sourced from pollTracker.lastEntry rather than a duplicate
    // field here, so there's exactly one place that records when a cycle
    // last completed.
    this.cacheAgeSeconds = new AbsentUntilSetGauge(
      registry,
      "technitium_exporter_cache_age_seconds",
      "Seconds since this target's cache was last refreshed, computed at collect time",
      () =>
        (this.#clock.elapsed() - (pollTracker.lastEntry?.fetchedAt ?? this.#clock.elapsed())) /
        1000,
    );

    this.pollTotal = new Counter({
      name: "technitium_exporter_poll_total",
      help: "Total poll cycles attempted for this target, regardless of outcome",
      registers,
    });

    this.pollErrorsTotal = new Counter<"reason">({
      name: "technitium_exporter_poll_errors_total",
      help: "Total per-collector-attempt failures within a poll cycle for this target, by reason — one cycle with several failing collectors increments this more than once",
      labelNames: ["reason"],
      registers,
    });

    this.pollDurationSeconds = new Histogram({
      name: "technitium_exporter_poll_duration_seconds",
      help: "Wall-clock duration of a poll cycle for this target",
      buckets: DURATION_SECONDS_BUCKETS,
      registers,
    });

    this.upstreamRequestsTotal = new Counter<"endpoint" | "status_code">({
      name: "technitium_exporter_upstream_requests_total",
      help: "Total upstream HTTP attempts against this target, by endpoint and outcome",
      labelNames: ["endpoint", "status_code"],
      registers,
    });

    this.upstreamRequestDurationSeconds = new Histogram<"endpoint">({
      name: "technitium_exporter_upstream_request_duration_seconds",
      help: "Duration of an upstream HTTP attempt against this target, by endpoint",
      labelNames: ["endpoint"],
      buckets: DURATION_SECONDS_BUCKETS,
      registers,
    });

    this.parseErrorsTotal = new Counter<"group">({
      name: "technitium_exporter_parse_errors_total",
      help: "Total parse failures for this target, by collector group",
      labelNames: ["group"],
      registers,
    });

    this.series = new Gauge({
      name: seriesMetricName,
      help: "Total number of series this target's registry would currently render, excluding this series itself (N7 cardinality tripwire)",
      registers,
      // Excludes this gauge's own single series from the count: including it
      // would add a constant +1 that carries no signal about actual growth,
      // and — since a Gauge's own collect() runs via this same .get() call —
      // counting it would mean calling .get() on this metric from inside its
      // own collect(), recursing forever.
      //
      // Calling .get() on every other collect-backed metric here also fires
      // that metric's own collect() a second time (once here, once again via
      // the registry's normal render pass) — harmless today because
      // cache_age_seconds's collect() is idempotent and it's the only other
      // one, but a future non-idempotent collect() would be double-fired by
      // this tally rather than architected around.
      collect: async () => {
        const others = (registry.getMetricsAsArray() as unknown as readonly MetricWithGet[]).filter(
          (metric) => metric.name !== seriesMetricName,
        );
        const results = await Promise.all(others.map((metric) => metric.get()));
        const total = results.reduce((sum, result) => sum + (result.values?.length ?? 0), 0);
        this.series.set(total);
      },
    });

    this.tlsVerificationDisabled = new Gauge({
      name: "technitium_exporter_tls_verification_disabled",
      help: "1 if this target has TLS certificate verification disabled",
      registers,
    });
    this.tlsVerificationDisabled.set(options.tlsInsecureSkipVerify ? 1 : 0);
  }

  // Called exactly once per poll cycle regardless of outcome — pollTotal's
  // own "attempted, not succeeded" semantic — with durationMs measured by the
  // caller as wall time (via the monotonic clock) around the whole cycle.
  recordPollCycle(outcome: "success" | "failure", durationMs: number): void {
    this.pollTotal.inc();
    this.pollDurationSeconds.observe(durationMs / 1000);
    if (outcome === "success") {
      this.lastSuccessfulPollTimestampSeconds.set(this.#clock.now() / 1000);
    }
  }

  recordPollError(reason: PollErrorReason): void {
    this.pollErrorsTotal.labels({ reason }).inc();
  }

  recordParseError(group: string): void {
    this.parseErrorsTotal.labels({ group }).inc();
  }

  // One call per real upstream HTTP attempt (http/client.ts's own
  // onUpstreamAttempt hook fires once per attempt, including a retried one).
  recordUpstreamAttempt(outcome: UpstreamAttemptOutcome): void {
    const statusCode = "statusCode" in outcome ? String(outcome.statusCode) : outcome.reason;
    this.upstreamRequestsTotal.labels({ endpoint: outcome.path, status_code: statusCode }).inc();
    this.upstreamRequestDurationSeconds
      .labels({ endpoint: outcome.path })
      .observe(outcome.durationMs / 1000);
  }

  // Called once this target's first poll cycle has completed (success or
  // failure alike — must be called no earlier than the same cycle's
  // pollTracker.record(), which is the actual source of the fetchedAt value
  // cache_age_seconds's own collect callback reads). Idempotent: every call
  // after the first is a no-op, since the underlying gauge is already
  // present. What's cached is whatever the last cycle produced, and its age
  // is meaningful even when that cycle failed and every collector reset its
  // own series to absent.
  noteCacheFetch(): void {
    this.cacheAgeSeconds.ensurePresent();
  }
}
