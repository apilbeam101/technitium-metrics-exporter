import { Counter, Gauge, type Registry } from "@prometheus-io/client";
import type { CounterField, NativeLifetimeCounters } from "../api/native-text.ts";
import { AbsentUntilSetGauge } from "./absent-gauge.ts";

type GaugeField = "uptimeSeconds" | "startTimeSeconds";

interface FieldSpec {
  readonly name: string;
  readonly help: string;
}

// Keyed by field, not a plain array of {field, name, help} entries: a
// mapped Record over CounterField/GaugeField makes an entry accidentally
// dropped (e.g. during a future rename) a compile error, not a silent
// runtime gap — an array of the same shape type-checks fine with an entry
// missing, since ReadonlyArray<FieldSpec> only constrains element shape,
// never coverage of the union. This one table still drives both
// construction and application for every one of the thirteen value-bearing
// fields, so adding a field is still a one-site edit.
const COUNTER_FIELD_SPECS: Readonly<Record<CounterField, FieldSpec>> = {
  queriesTotal: {
    name: "technitium_queries_total",
    help: "Total DNS queries received, normalised from metrics/text (either name spelling)",
  },
  noErrorTotal: {
    name: "technitium_no_error_total",
    help: "Total queries answered NOERROR, normalised from metrics/text",
  },
  serverFailureTotal: {
    name: "technitium_server_failure_total",
    help: "Total queries answered SERVFAIL, normalised from metrics/text",
  },
  nxDomainTotal: {
    name: "technitium_nx_domain_total",
    help: "Total queries answered NXDOMAIN, normalised from metrics/text",
  },
  refusedTotal: {
    name: "technitium_refused_total",
    help: "Total queries answered REFUSED, normalised from metrics/text",
  },
  authoritativeTotal: {
    name: "technitium_authoritative_total",
    help: "Total queries answered authoritatively, normalised from metrics/text",
  },
  recursiveTotal: {
    name: "technitium_recursive_total",
    help: "Total queries answered recursively, normalised from metrics/text",
  },
  cachedTotal: {
    name: "technitium_cached_total",
    help: "Total queries answered from cache, normalised from metrics/text",
  },
  blockedTotal: {
    name: "technitium_blocked_total",
    help: "Total queries blocked, normalised from metrics/text",
  },
  droppedTotal: {
    name: "technitium_dropped_total",
    help: "Total queries dropped, normalised from metrics/text",
  },
  clientsTotal: {
    name: "technitium_clients_total",
    help: "Total distinct clients seen, normalised from metrics/text",
  },
};

const GAUGE_FIELD_SPECS: Readonly<Record<GaugeField, FieldSpec>> = {
  uptimeSeconds: {
    name: "technitium_uptime_seconds",
    help: "Seconds elapsed since the DNS server process started",
  },
  startTimeSeconds: {
    name: "technitium_start_time_seconds",
    help: "Unix time the DNS server process started, converted from milliseconds",
  },
};

function counterFields(): readonly CounterField[] {
  return Object.keys(COUNTER_FIELD_SPECS) as CounterField[];
}

function gaugeFields(): readonly GaugeField[] {
  return Object.keys(GAUGE_FIELD_SPECS) as GaugeField[];
}

// A label-free Counter always renders exactly one series from the moment
// it's constructed — reset()/inc() cannot make it disappear, since there's
// no label combination to remove (same problem absent-gauge.ts's
// AbsentUntilSetGauge solves for its own label-free gauges). Each of these
// thirteen metrics must instead be genuinely absent until its field first
// has a real value, and go absent again if a later successful poll no
// longer reports that field (e.g. mid-migration to a renamed metric) —
// counters must not freeze at a stale value in that case, unlike a fully
// failed poll cycle, where freezing is the correct counter semantic (D§5.5's
// gauge/counter distinction only governs window-vs-lifetime values, not
// this absent-vs-frozen distinction, which has no direct DESIGN.md
// precedent beyond D§3.2.7's "absent conditional fields, never zero" zone
// rule generalized here to a field missing from an otherwise-successful
// response).
class OptionalCounter {
  readonly #registry: Registry;
  readonly #name: string;
  readonly #help: string;
  #counter: Counter | undefined;

  constructor(registry: Registry, name: string, help: string) {
    this.#registry = registry;
    this.#name = name;
    this.#help = help;
  }

  setOrClear(value: number | undefined): void {
    if (value === undefined) {
      this.#clear();
      return;
    }
    this.#counter ??= new Counter({
      name: this.#name,
      help: this.#help,
      registers: [this.#registry],
    });
    this.#counter.reset();
    this.#counter.inc(value);
  }

  #clear(): void {
    if (this.#counter === undefined) return;
    this.#registry.removeSingleMetric(this.#name);
    this.#counter = undefined;
  }
}

export interface NativeMetrics {
  readonly counters: Readonly<Record<CounterField, OptionalCounter>>;
  readonly gauges: Readonly<Record<GaugeField, AbsentUntilSetGauge>>;
  readonly lifetimeCountersSupported: Gauge;
  readonly unknownNativeMetric: Counter<"name">;
  // Shared with session-metrics.ts's own Gauge instance (created once per
  // target, there, and exposed via SessionCollector.collectorSuccess), not
  // created here — session-collector.ts's permission gating and this
  // collector's own outcome both write to
  // technitium_collector_success{collector="native"}, and a Registry rejects
  // a second registration of the same metric name (D§4.4).
  readonly collectorSuccess: Gauge<"collector">;
}

// Every metric other than collectorSuccess registers only into the Registry
// passed in, same as session-metrics.ts (D§4.4), so this stays independently
// testable and per-target isolated.
export function createNativeMetrics(
  registry: Registry,
  collectorSuccess: Gauge<"collector">,
): NativeMetrics {
  const counters = {} as Record<CounterField, OptionalCounter>;
  for (const field of counterFields()) {
    const spec = COUNTER_FIELD_SPECS[field];
    counters[field] = new OptionalCounter(registry, spec.name, spec.help);
  }

  const gauges = {} as Record<GaugeField, AbsentUntilSetGauge>;
  for (const field of gaugeFields()) {
    const spec = GAUGE_FIELD_SPECS[field];
    gauges[field] = new AbsentUntilSetGauge(registry, spec.name, spec.help);
  }

  return {
    counters,
    gauges,
    // Deliberately eager, unlike the thirteen OptionalCounter/AbsentUntilSetGauge
    // fields above: this is a health flag in the same category as
    // technitium_up and collectorSuccess, not a value with no honest
    // default. "Not yet successfully polled" is itself the correct 0, the
    // same way technitium_up is honestly 0 before a target's first poll —
    // it's not a phantom value standing in for a real one.
    lifetimeCountersSupported: new Gauge({
      name: "technitium_lifetime_counters_supported",
      help: "0 when metrics/text was missing or unparseable on the last poll",
      registers: [registry],
    }),
    unknownNativeMetric: new Counter<"name">({
      name: "technitium_exporter_unknown_native_metric_total",
      help: "Count of metric names seen from metrics/text outside this exporter's recognized set",
      labelNames: ["name"],
      registers: [registry],
    }),
    collectorSuccess,
  };
}

// lifetimeCountersSupported and collectorSuccess are set last, the same
// last-write ordering session-metrics.ts uses for technitium_up: a throw
// partway through this function must not leave either at 1 for a poll cycle
// that didn't actually finish applying its result. The thirteen value
// fields deliberately are NOT cleared here: a failed poll cycle (server
// unreachable, auth rejected) is a transient gap, and a genuine Prometheus
// counter/gauge is supposed to hold its last known value across one, the
// same way Prometheus itself does when a scrape target is briefly down.
export function applyNativeFailure(metrics: NativeMetrics): void {
  metrics.lifetimeCountersSupported.set(0);
  metrics.collectorSuccess.labels({ collector: "native" }).set(0);
}

export function applyNativeSuccess(metrics: NativeMetrics, counters: NativeLifetimeCounters): void {
  for (const field of counterFields()) {
    metrics.counters[field].setOrClear(counters[field]);
  }
  for (const field of gaugeFields()) {
    metrics.gauges[field].setOrClear(counters[field]);
  }

  for (const name of counters.unknownMetricNames) {
    metrics.unknownNativeMetric.labels({ name }).inc();
  }

  metrics.lifetimeCountersSupported.set(1);
  metrics.collectorSuccess.labels({ collector: "native" }).set(1);
}
