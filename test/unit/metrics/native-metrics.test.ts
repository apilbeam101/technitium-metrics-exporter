import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Gauge, Registry } from "@prometheus-io/client";
import type { NativeLifetimeCounters } from "../../../src/api/native-text.ts";
import {
  applyNativeFailure,
  applyNativeSuccess,
  createNativeMetrics,
} from "../../../src/metrics/native-metrics.ts";

async function valuesOf(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === name);
  assert.ok(metric, `no metric registered named ${name}`);
  return metric.values;
}

function sharedCollectorSuccess(registry: Registry): Gauge<"collector"> {
  return new Gauge<"collector">({
    name: "technitium_collector_success",
    help: "Per-collector outcome of the last poll cycle",
    labelNames: ["collector"],
    registers: [registry],
  });
}

function counters(overrides: Partial<NativeLifetimeCounters> = {}): NativeLifetimeCounters {
  return {
    queriesTotal: 100000,
    noErrorTotal: 90000,
    serverFailureTotal: 500,
    nxDomainTotal: 4000,
    refusedTotal: 100,
    authoritativeTotal: 60000,
    recursiveTotal: 40000,
    cachedTotal: 30000,
    blockedTotal: 5000,
    droppedTotal: 100,
    clientsTotal: 250,
    uptimeSeconds: 12345,
    startTimeSeconds: 1700000000,
    unknownMetricNames: [],
    ...overrides,
  };
}

describe("applyNativeSuccess", () => {
  it("re-exports every lifetime counter under its stable prefixed name", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters());

    assert.equal((await valuesOf(registry, "technitium_queries_total"))[0]?.value, 100000);
    assert.equal((await valuesOf(registry, "technitium_no_error_total"))[0]?.value, 90000);
    assert.equal((await valuesOf(registry, "technitium_uptime_seconds"))[0]?.value, 12345);
    assert.equal((await valuesOf(registry, "technitium_start_time_seconds"))[0]?.value, 1700000000);
  });

  it("sets lifetime_counters_supported and collector_success to 1 on success", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters());

    assert.equal((await valuesOf(registry, "technitium_lifetime_counters_supported"))[0]?.value, 1);
    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(success, [{ value: 1, labels: { collector: "native" } }]);
  });

  it("re-setting the counters to a new absolute total does not double-count the previous value", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters({ queriesTotal: 100 }));
    applyNativeSuccess(metrics, counters({ queriesTotal: 150 }));

    assert.equal((await valuesOf(registry, "technitium_queries_total"))[0]?.value, 150);
  });

  it("increments the unknown-native-metric counter once per unrecognized name, keyed by name", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters({ unknownMetricNames: ["future_metric"] }));

    const unknown = await valuesOf(registry, "technitium_exporter_unknown_native_metric_total");
    assert.deepEqual(unknown, [{ value: 1, labels: { name: "future_metric" } }]);
  });

  it("leaves a field's series genuinely absent, not present-and-zero, before it ever has a defined value", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters({ queriesTotal: undefined, uptimeSeconds: undefined }));

    const registered = await registry.getMetricsAsJSON();
    assert.deepEqual(
      registered.find((m) => m.name === "technitium_queries_total")?.values ?? [],
      [],
    );
    assert.deepEqual(
      registered.find((m) => m.name === "technitium_uptime_seconds")?.values ?? [],
      [],
    );
  });

  it("removes a field's series once a later successful cycle no longer reports it (an in-progress upstream rename), for both counters and gauges", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters());
    assert.equal((await valuesOf(registry, "technitium_queries_total"))[0]?.value, 100000);
    assert.equal((await valuesOf(registry, "technitium_uptime_seconds"))[0]?.value, 12345);

    applyNativeSuccess(metrics, counters({ queriesTotal: undefined, uptimeSeconds: undefined }));

    const registered = await registry.getMetricsAsJSON();
    assert.deepEqual(
      registered.find((m) => m.name === "technitium_queries_total")?.values ?? [],
      [],
    );
    assert.deepEqual(
      registered.find((m) => m.name === "technitium_uptime_seconds")?.values ?? [],
      [],
    );
  });
});

describe("applyNativeFailure", () => {
  it("sets lifetime_counters_supported and collector_success to 0", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeFailure(metrics);

    assert.equal((await valuesOf(registry, "technitium_lifetime_counters_supported"))[0]?.value, 0);
    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(success, [{ value: 0, labels: { collector: "native" } }]);
  });

  it("freezes an already-registered counter/gauge at its last known value rather than clearing it (a transient poll failure, not a rename)", async () => {
    const registry = new Registry();
    const metrics = createNativeMetrics(registry, sharedCollectorSuccess(registry));
    applyNativeSuccess(metrics, counters());

    applyNativeFailure(metrics);

    assert.equal((await valuesOf(registry, "technitium_queries_total"))[0]?.value, 100000);
    assert.equal((await valuesOf(registry, "technitium_uptime_seconds"))[0]?.value, 12345);
  });
});
