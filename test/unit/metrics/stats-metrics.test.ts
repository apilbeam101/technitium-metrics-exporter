import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { StatsWindowDetail } from "../../../src/api/stats.ts";
import {
  applyStatsFailure,
  applyStatsSuccess,
  createStatsMetrics,
  STATS_WINDOW_SECONDS,
} from "../../../src/metrics/stats-metrics.ts";

function sharedCollectorSuccess(registry: Registry): Gauge<"collector"> {
  return new Gauge<"collector">({
    name: "technitium_collector_success",
    help: "Per-collector outcome of the last poll cycle",
    labelNames: ["collector"],
    registers: [registry],
  });
}

function sharedUnknownEnum(registry: Registry): Counter<"metric" | "value"> {
  return new Counter<"metric" | "value">({
    name: "technitium_exporter_unknown_enum_total",
    help: "Count of enum values seen outside this exporter's recognized set",
    labelNames: ["metric", "value"],
    registers: [registry],
  });
}

async function valuesOf(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values ?? [];
}

async function firstValueOf(registry: Registry, name: string): Promise<number | undefined> {
  return (await valuesOf(registry, name))[0]?.value;
}

function detail(overrides: Partial<StatsWindowDetail> = {}): StatsWindowDetail {
  return {
    queriesByProtocol: new Map([
      ["Udp", 800],
      ["Tcp", 150],
      ["Tls", 20],
      ["Https", 25],
      ["Quic", 5],
    ]),
    queriesByResponseType: new Map([
      ["Authoritative", 600],
      ["Recursive", 400],
      ["Cached", 300],
      ["Blocked", 50],
      ["Dropped", 1],
    ]),
    queryTypes: new Map([
      ["A", 500],
      ["AAAA", 300],
    ]),
    zonesReported: 11,
    cachedEntries: 1200,
    allowedZones: 0,
    blockedZones: 3,
    allowListZones: 0,
    blockListZones: 1,
    ...overrides,
  };
}

describe("applyStatsSuccess", () => {
  it("re-exports all five protocol values and all five response-type values", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail());

    const protocolValues = await valuesOf(registry, "technitium_stats_window_queries");
    assert.deepEqual(
      new Set(protocolValues.map((v) => v.labels.protocol)),
      new Set(["Udp", "Tcp", "Tls", "Https", "Quic"]),
    );
    assert.ok(protocolValues.some((v) => v.labels.protocol === "Udp" && v.value === 800));

    const responseValues = await valuesOf(registry, "technitium_stats_window_queries_by_response");
    assert.deepEqual(
      new Set(responseValues.map((v) => v.labels.response_type)),
      new Set(["Authoritative", "Recursive", "Cached", "Blocked", "Dropped"]),
    );
  });

  it("zero-fills a protocol absent from the response rather than omitting its series", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail({ queriesByProtocol: new Map([["Udp", 100]]) }));

    const values = await valuesOf(registry, "technitium_stats_window_queries");
    assert.equal(values.find((v) => v.labels.protocol === "Tcp")?.value, 0);
    assert.equal(values.length, 5);
  });

  it("counts an unrecognized protocol label into the shared unknown-enum series instead of adding a sixth label", async () => {
    const registry = new Registry();
    const unknownEnum = sharedUnknownEnum(registry);
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      unknownEnum,
      false,
    );
    applyStatsSuccess(
      metrics,
      detail({
        queriesByProtocol: new Map([
          ["Udp", 100],
          ["Http3", 5],
        ]),
      }),
    );

    const values = await valuesOf(registry, "technitium_stats_window_queries");
    assert.equal(values.length, 5);
    const unknown = await valuesOf(registry, "technitium_exporter_unknown_enum_total");
    assert.ok(
      unknown.some(
        (v) => v.labels.metric === "stats_protocol" && v.labels.value === "Http3" && v.value === 1,
      ),
    );
  });

  it("does not register technitium_stats_window_queries_by_type unless query types are included", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail());

    assert.deepEqual(await valuesOf(registry, "technitium_stats_window_queries_by_type"), []);
  });

  it("exports the query-type split, reset then repopulated, when included", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      true,
    );
    applyStatsSuccess(metrics, detail());
    let values = await valuesOf(registry, "technitium_stats_window_queries_by_type");
    assert.deepEqual(new Set(values.map((v) => v.labels.query_type)), new Set(["A", "AAAA"]));

    applyStatsSuccess(metrics, detail({ queryTypes: new Map([["MX", 10]]) }));
    values = await valuesOf(registry, "technitium_stats_window_queries_by_type");
    assert.deepEqual(
      values.map((v) => v.labels.query_type),
      ["MX"],
    );
  });

  it("exports the fixed window length alongside the split", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail());

    assert.equal(
      await firstValueOf(registry, "technitium_stats_window_seconds"),
      STATS_WINDOW_SECONDS,
    );
  });

  it("re-exports the D§5.3 zone total and the D§5.5 live-state gauges under their stable names", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail());

    assert.equal(await firstValueOf(registry, "technitium_zones_reported"), 11);
    assert.equal(await firstValueOf(registry, "technitium_cached_entries"), 1200);
    assert.equal(await firstValueOf(registry, "technitium_allowed_zones"), 0);
    assert.equal(await firstValueOf(registry, "technitium_blocked_zones"), 3);
    assert.equal(await firstValueOf(registry, "technitium_allow_list_zones"), 0);
    assert.equal(await firstValueOf(registry, "technitium_block_list_zones"), 1);
  });

  it("leaves a live-state field genuinely absent when the response omits it", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail({ zonesReported: undefined, cachedEntries: undefined }));

    assert.deepEqual(await valuesOf(registry, "technitium_zones_reported"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_cached_entries"), []);
  });

  it("sets collector_success to 1", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsSuccess(metrics, detail());

    assert.deepEqual(await valuesOf(registry, "technitium_collector_success"), [
      { value: 1, labels: { collector: "stats" } },
    ]);
  });
});

describe("applyStatsFailure", () => {
  it("clears every series this collector owns to genuinely absent, not zero — a live snapshot, not a lifetime total", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      true,
    );
    applyStatsSuccess(metrics, detail());

    applyStatsFailure(metrics);

    assert.deepEqual(await valuesOf(registry, "technitium_stats_window_queries"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_stats_window_queries_by_response"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_stats_window_queries_by_type"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_stats_window_seconds"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_zones_reported"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_cached_entries"), []);
  });

  it("sets collector_success to 0", async () => {
    const registry = new Registry();
    const metrics = createStatsMetrics(
      registry,
      sharedCollectorSuccess(registry),
      sharedUnknownEnum(registry),
      false,
    );
    applyStatsFailure(metrics);

    assert.deepEqual(await valuesOf(registry, "technitium_collector_success"), [
      { value: 0, labels: { collector: "stats" } },
    ]);
  });

  it("does not disturb another collector's own collector_success child sharing the same Gauge", async () => {
    const registry = new Registry();
    const collectorSuccess = sharedCollectorSuccess(registry);
    collectorSuccess.labels({ collector: "native" }).set(1);
    const metrics = createStatsMetrics(
      registry,
      collectorSuccess,
      sharedUnknownEnum(registry),
      false,
    );

    applyStatsFailure(metrics);

    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(
      success.find((v) => v.labels.collector === "native"),
      { value: 1, labels: { collector: "native" } },
    );
  });
});
