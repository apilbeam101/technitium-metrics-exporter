import { TechnitiumHttpError } from "../http/errors.ts";
import { assertOk, classifyEnvelope } from "./envelope.ts";

export type CounterField =
  | "queriesTotal"
  | "noErrorTotal"
  | "serverFailureTotal"
  | "nxDomainTotal"
  | "refusedTotal"
  | "authoritativeTotal"
  | "recursiveTotal"
  | "cachedTotal"
  | "blockedTotal"
  | "droppedTotal"
  | "clientsTotal";

// Every field is optional, not required: a field missing from one response
// is not a parse failure on its own — D§5.4's unknown-metric counter exists
// precisely so a future upstream rename shows up as a visible signal
// (technitium_exporter_unknown_native_metric_total{name}) plus the renamed
// field going absent, rather than a parse error that discards that same
// unknown name and freezes or zeroes every other, unrelated counter too.
export type NativeLifetimeCounters = Readonly<Record<CounterField, number | undefined>> & {
  readonly uptimeSeconds: number | undefined;
  readonly startTimeSeconds: number | undefined;
  // Any name outside D§5.4's mapped set, so the caller can increment
  // technitium_exporter_unknown_native_metric_total the moment upstream adds
  // or renames a metric (N8) instead of the render silently dropping it.
  readonly unknownMetricNames: readonly string[];
};

// D§5.4/D§3.2.2: both of upstream's spellings for the same eleven lifetime
// counters map to one stable exported field — current deployments emit the
// right-hand spelling, but published references still show the left, and the
// endpoint is documented as "experimental and may change in later releases."
const COUNTER_NAME_PAIRS: ReadonlyArray<{
  readonly legacy: string;
  readonly current: string;
  readonly field: CounterField;
}> = [
  { legacy: "total_queries", current: "queries_total", field: "queriesTotal" },
  { legacy: "total_no_error", current: "no_error_total", field: "noErrorTotal" },
  { legacy: "total_server_failure", current: "server_failure_total", field: "serverFailureTotal" },
  { legacy: "total_nx_domain", current: "nx_domain_total", field: "nxDomainTotal" },
  { legacy: "total_refused", current: "refused_total", field: "refusedTotal" },
  { legacy: "total_authoritative", current: "authoritative_total", field: "authoritativeTotal" },
  { legacy: "total_recursive", current: "recursive_total", field: "recursiveTotal" },
  { legacy: "total_cached", current: "cached_total", field: "cachedTotal" },
  { legacy: "total_blocked", current: "blocked_total", field: "blockedTotal" },
  { legacy: "total_dropped", current: "dropped_total", field: "droppedTotal" },
  { legacy: "total_clients", current: "clients_total", field: "clientsTotal" },
];

const NAME_TO_FIELD = new Map<string, CounterField>();
for (const { legacy, current, field } of COUNTER_NAME_PAIRS) {
  NAME_TO_FIELD.set(legacy, field);
  NAME_TO_FIELD.set(current, field);
}

// D§3.2.3: uptime_seconds and start_time carry no dual spelling and are read
// directly, unlike the eleven mapped counters above.
const UPTIME_NAME = "uptime_seconds";
const START_TIME_NAME = "start_time";

// This endpoint's grammar (D§3.2.2): "# HELP", "# TYPE" and "name value"
// lines only, with no labels, timestamps or exemplars. Comment lines are
// skipped without interpreting their content — the exporter defines its own
// metric types (D§5.4/D§5.1) rather than trusting upstream's own "# TYPE".
// Negative values are rejected here (never a legitimate lifetime total) so a
// malformed body is classified "parse" at the one place that knows it's
// malformed, rather than surfacing later as an uncaught prom-client throw
// with an "unknown" PollErrorReason.
function parseGrammarLines(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const tokens = line.split(/\s+/);
    const name = tokens[0];
    const valueText = tokens[1];
    const value = valueText === undefined ? Number.NaN : Number(valueText);
    if (tokens.length !== 2 || name === undefined || !Number.isFinite(value) || value < 0) {
      throw new TechnitiumHttpError("parse", `metrics/text: malformed line "${line}"`);
    }
    values.set(name, value);
  }
  return values;
}

// D§3.2.1: metrics/text is dual-format — Prometheus text on success, JSON on
// error — so a leading "{" (after whitespace) is what routes a response into
// the shared envelope classifier instead of the Prometheus-text grammar. No
// valid Prometheus exposition line can begin with "{" (D§3.2.2: this
// endpoint emits no labels at all), so the body's own shape is a sufficient
// signal without needing the HTTP Content-Type header, which isn't threaded
// through http/client.ts's RawResponse.
export function parseNativeMetricsText(rawBody: string): NativeLifetimeCounters {
  const trimmed = rawBody.trim();

  if (trimmed.startsWith("{")) {
    assertOk(classifyEnvelope(rawBody, "wrapped"), "metrics/text");
    // classifyEnvelope only returns without throwing on status "ok", which
    // this endpoint's documented behaviour never produces as JSON (D§3.2.1)
    // — reachable only if that assumption is ever wrong, in which case this
    // body still isn't Prometheus text.
    throw new TechnitiumHttpError("parse", 'metrics/text: unexpected JSON body with status "ok"');
  }

  const rawValues = parseGrammarLines(trimmed);

  const counters = new Map<CounterField, number>();
  const unknownMetricNames: string[] = [];

  for (const [name, value] of rawValues) {
    if (name === UPTIME_NAME || name === START_TIME_NAME) continue;
    const field = NAME_TO_FIELD.get(name);
    if (field === undefined) {
      unknownMetricNames.push(name);
      continue;
    }
    counters.set(field, value);
  }

  const uptimeSeconds = rawValues.get(UPTIME_NAME);
  const startTimeMs = rawValues.get(START_TIME_NAME);

  return {
    queriesTotal: counters.get("queriesTotal"),
    noErrorTotal: counters.get("noErrorTotal"),
    serverFailureTotal: counters.get("serverFailureTotal"),
    nxDomainTotal: counters.get("nxDomainTotal"),
    refusedTotal: counters.get("refusedTotal"),
    authoritativeTotal: counters.get("authoritativeTotal"),
    recursiveTotal: counters.get("recursiveTotal"),
    cachedTotal: counters.get("cachedTotal"),
    blockedTotal: counters.get("blockedTotal"),
    droppedTotal: counters.get("droppedTotal"),
    clientsTotal: counters.get("clientsTotal"),
    // D§3.2.3: start_time arrives in milliseconds, against the Prometheus
    // seconds convention.
    uptimeSeconds,
    startTimeSeconds: startTimeMs === undefined ? undefined : startTimeMs / 1000,
    unknownMetricNames,
  };
}
