import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Gauge, Registry } from "@prometheus-io/client";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { NativeCollector } from "../../../src/metrics/native-collector.ts";
import { SessionCollector } from "../../../src/metrics/session-collector.ts";

const CURRENT_NAMES = readFileSync("test/fixtures/native/metrics-text-current-names.txt", "utf8");
const LEGACY_NAMES = readFileSync("test/fixtures/native/metrics-text-legacy-names.txt", "utf8");
const UNKNOWN_METRIC = readFileSync("test/fixtures/native/metrics-text-unknown-metric.txt", "utf8");
const ERROR_BODY = readFileSync("test/fixtures/native/metrics-text-error.json", "utf8");
// D§3.1: this fixture's token has Dashboard: View granted, which is what
// ungates the "native" collector in session-collector.ts's permission table.
const V15_CLUSTERED = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");

function stubClient(body: string | (() => Promise<never>)) {
  return {
    get: async () => {
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
  };
}

function sharedCollectorSuccess(registry: Registry): Gauge<"collector"> {
  return new Gauge<"collector">({
    name: "technitium_collector_success",
    help: "Per-collector outcome of the last poll cycle",
    labelNames: ["collector"],
    registers: [registry],
  });
}

async function valueOfMetric(registry: Registry, name: string): Promise<number | undefined> {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values[0]?.value;
}

// Byte-stable only for the "first poll, all thirteen fields present" path
// this fixture exercises. Because each of the thirteen OptionalCounter/
// OptionalGauge fields registers on first defined value (native-metrics.ts),
// a later poll where a field appears for the first time (or reappears after
// a rename) legitimately moves that family to a different position in the
// output — a valid Prometheus exposition (family order is unconstrained;
// samples within a family stay contiguous), just not this golden file's
// order. A rename/partial-poll scenario would need its own golden fixture
// captured from that exact sequence, not a reuse of this one.
const GOLDEN_LIFETIME_COUNTERS = readFileSync(
  "test/fixtures/golden/native-lifetime-counters.txt",
  "utf8",
);

describe("NativeCollector.collect", () => {
  it("produces byte-identical exposition text from either upstream spelling", async () => {
    const registryCurrent = new Registry();
    await new NativeCollector({
      httpClient: stubClient(CURRENT_NAMES),
      registry: registryCurrent,
      collectorSuccess: sharedCollectorSuccess(registryCurrent),
    }).collect();

    const registryLegacy = new Registry();
    await new NativeCollector({
      httpClient: stubClient(LEGACY_NAMES),
      registry: registryLegacy,
      collectorSuccess: sharedCollectorSuccess(registryLegacy),
    }).collect();

    assert.equal(await registryCurrent.metrics(), await registryLegacy.metrics());
  });

  it("matches the committed golden exposition text from either upstream spelling", async () => {
    for (const body of [CURRENT_NAMES, LEGACY_NAMES]) {
      const registry = new Registry();
      await new NativeCollector({
        httpClient: stubClient(body),
        registry,
        collectorSuccess: sharedCollectorSuccess(registry),
      }).collect();

      assert.equal(await registry.metrics(), GOLDEN_LIFETIME_COUNTERS);
    }
  });

  it("sets technitium_lifetime_counters_supported to 1 on success", async () => {
    const registry = new Registry();
    const result = await new NativeCollector({
      httpClient: stubClient(CURRENT_NAMES),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
    }).collect();

    assert.equal(result.kind, "success");
    assert.equal(await valueOfMetric(registry, "technitium_lifetime_counters_supported"), 1);
  });

  it("counts an unrecognized metric name without breaking the render", async () => {
    const registry = new Registry();
    const result = await new NativeCollector({
      httpClient: stubClient(UNKNOWN_METRIC),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
    }).collect();

    assert.equal(result.kind, "success");
    assert.equal(await valueOfMetric(registry, "technitium_queries_total"), 100000);
    const metrics = await registry.getMetricsAsJSON();
    const unknown =
      metrics.find((m) => m.name === "technitium_exporter_unknown_native_metric_total")?.values ??
      [];
    assert.deepEqual(unknown, [{ value: 1, labels: { name: "future_metric_not_yet_mapped" } }]);
  });

  it("produces no phantom counters from a JSON error body, and sets lifetime_counters_supported to 0", async () => {
    const registry = new Registry();
    const result = await new NativeCollector({
      httpClient: stubClient(ERROR_BODY),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
    }).collect();

    assert.equal(result.kind, "failure");
    assert.equal(await valueOfMetric(registry, "technitium_lifetime_counters_supported"), 0);
    // Every one of the thirteen value-bearing metrics is genuinely absent,
    // not present-and-zero, until at least one successful poll — a JSON
    // error body never gets that far.
    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(metrics.find((m) => m.name === "technitium_queries_total")?.values ?? [], []);
    assert.deepEqual(metrics.find((m) => m.name === "technitium_uptime_seconds")?.values ?? [], []);
  });

  it("removes a counter's series entirely once its field stops appearing in a later, otherwise-successful poll (an in-progress upstream rename)", async () => {
    const registry = new Registry();
    let currentBody = CURRENT_NAMES;
    // A single collector instance is reused across both poll cycles, exactly
    // as a real per-target poll loop would (same pattern as
    // session-collector.test.ts's own "drops a peer removed between two
    // poll cycles" test).
    const collector = new NativeCollector({
      httpClient: { get: async () => ({ statusCode: 200, body: currentBody }) },
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
    });
    await collector.collect();
    assert.equal(await valueOfMetric(registry, "technitium_queries_total"), 100000);

    currentBody = CURRENT_NAMES.replace("queries_total 100000", "queries_total_v2 100000");
    const result = await collector.collect();

    assert.equal(result.kind, "success");
    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(metrics.find((m) => m.name === "technitium_queries_total")?.values ?? [], []);
    const unknown =
      metrics.find((m) => m.name === "technitium_exporter_unknown_native_metric_total")?.values ??
      [];
    assert.deepEqual(unknown, [{ value: 1, labels: { name: "queries_total_v2" } }]);
  });

  it('sets collector_success{collector="native"} to 0 for an unreachable target', async () => {
    const registry = new Registry();
    const result = await new NativeCollector({
      httpClient: stubClient(() => {
        throw new TechnitiumHttpError("network", "connection refused");
      }),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
    }).collect();

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.equal(result.reason, "network");
    const metrics = await registry.getMetricsAsJSON();
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.deepEqual(success, [{ value: 0, labels: { collector: "native" } }]);
  });

  it("shares technitium_collector_success with a SessionCollector's own Gauge instance in the same Registry, and is not clobbered by a subsequent ungated session poll", async () => {
    const registry = new Registry();
    const session = new SessionCollector({
      httpClient: { get: async () => ({ statusCode: 200, body: V15_CLUSTERED }) },
      registry,
      enabledCollectors: ["native"],
      warn: () => {},
    });
    await session.collect();

    const native = new NativeCollector({
      httpClient: stubClient(CURRENT_NAMES),
      registry,
      collectorSuccess: session.collectorSuccess,
    });
    await native.collect();

    // A second session poll cycle, with permission still granted, must not
    // remove the "native" series native.collect() just wrote.
    await session.collect();

    const metrics = await registry.getMetricsAsJSON();
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.deepEqual(
      success.find((v) => v.labels.collector === "native"),
      { value: 1, labels: { collector: "native" } },
    );
  });
});
