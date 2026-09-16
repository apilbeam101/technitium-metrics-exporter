import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { HttpClient } from "../../../src/http/client.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { StatsCollector } from "../../../src/metrics/stats-collector.ts";
import { FakeClock } from "../../support/fake-clock.ts";

const STATS_FULL = readFileSync("test/fixtures/stats/stats-get-full.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");

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

async function valueOfMetric(registry: Registry, name: string): Promise<number | undefined> {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values[0]?.value;
}

function countingClient(body: string | (() => Promise<never>)) {
  let calls = 0;
  const queries: Array<Record<string, string> | undefined> = [];
  return {
    get: async (_path: string, query?: Record<string, string>) => {
      calls++;
      queries.push(query);
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
    get calls() {
      return calls;
    },
    get queries() {
      return queries;
    },
  };
}

function baseOptions(
  registry: Registry,
  httpClient: Pick<HttpClient, "get">,
  overrides: { includeQueryTypes?: boolean; clock?: FakeClock; intervalMs?: number } = {},
) {
  return {
    httpClient,
    registry,
    collectorSuccess: sharedCollectorSuccess(registry),
    unknownEnum: sharedUnknownEnum(registry),
    includeQueryTypes: overrides.includeQueryTypes ?? false,
    clock: overrides.clock ?? new FakeClock(),
    intervalMs: overrides.intervalMs ?? 300_000,
    warn: () => {},
  };
}

describe("StatsCollector.collect", () => {
  it("applies the window-split and live-state metrics on a successful first cycle", async () => {
    const registry = new Registry();
    const client = countingClient(STATS_FULL);
    const result = await new StatsCollector(baseOptions(registry, client)).collect();

    assert.equal(result.kind, "success");
    assert.equal(await valueOfMetric(registry, "technitium_zones_reported"), 11);
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 1);
  });

  it("requests an explicit type=LastHour so the exported window length stays true regardless of upstream's own default", async () => {
    const registry = new Registry();
    const client = countingClient(STATS_FULL);
    await new StatsCollector(baseOptions(registry, client)).collect();

    assert.deepEqual(client.queries[0], { type: "LastHour" });
  });

  it("sets collector_success to 0 for an unreachable target, without ever having applied a value", async () => {
    const registry = new Registry();
    const client = countingClient(() => {
      throw new TechnitiumHttpError("network", "connection refused");
    });
    const result = await new StatsCollector(baseOptions(registry, client)).collect();

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.equal(result.reason, "network");
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 0);
    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(
      metrics.find((m) => m.name === "technitium_stats_window_seconds")?.values ?? [],
      [],
    );
  });

  it("does not re-fetch on a second cycle before the configured interval has elapsed, and reports fresh: false for it", async () => {
    const registry = new Registry();
    const client = countingClient(STATS_FULL);
    const clock = new FakeClock();
    const collector = new StatsCollector(
      baseOptions(registry, client, { clock, intervalMs: 60_000 }),
    );

    const first = await collector.collect();
    clock.advance(30_000);
    const second = await collector.collect();

    assert.equal(client.calls, 1);
    assert.equal(first.fresh, true);
    assert.equal(second.fresh, false);
  });

  it("re-fetches once the configured interval has elapsed, and reports fresh: true for that cycle", async () => {
    const registry = new Registry();
    const client = countingClient(STATS_FULL);
    const clock = new FakeClock();
    const collector = new StatsCollector(
      baseOptions(registry, client, { clock, intervalMs: 60_000 }),
    );

    await collector.collect();
    clock.advance(60_000);
    const second = await collector.collect();

    assert.equal(client.calls, 2);
    assert.equal(second.fresh, true);
  });

  it("freezes nothing and clears the live-state series while collector_success drops to 0 on a subsequent failed fetch", async () => {
    const registry = new Registry();
    let mode: "succeed" | "fail" = "succeed";
    const clock = new FakeClock();
    const collector = new StatsCollector(
      baseOptions(
        registry,
        {
          get: async () => {
            if (mode === "fail") throw new TechnitiumHttpError("network", "connection refused");
            return { statusCode: 200, body: STATS_FULL };
          },
        },
        { clock, intervalMs: 60_000 },
      ),
    );

    await collector.collect();
    assert.equal(await valueOfMetric(registry, "technitium_zones_reported"), 11);

    mode = "fail";
    clock.advance(60_000);
    const result = await collector.collect();

    assert.equal(result.kind, "failure");
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 0);
    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(metrics.find((m) => m.name === "technitium_zones_reported")?.values ?? [], []);
  });

  it("reports the last actual fetch's outcome on an off-cadence cycle, not a default, and marks that cycle fresh: false", async () => {
    const registry = new Registry();
    const clock = new FakeClock();
    const client = countingClient(() => {
      throw new TechnitiumHttpError("auth", "invalid token");
    });
    const collector = new StatsCollector(
      baseOptions(registry, client, { clock, intervalMs: 60_000 }),
    );

    await collector.collect();
    clock.advance(1_000);
    const result = await collector.collect();

    assert.equal(result.kind, "failure");
    assert.equal(result.fresh, false);
    if (result.kind === "failure") assert.equal(result.reason, "auth");
  });

  it("warns once on the transition into failure, not on every failing cycle", async () => {
    const registry = new Registry();
    const warnings: string[] = [];
    const clock = new FakeClock();
    const collector = new StatsCollector({
      ...baseOptions(registry, countingClient(INVALID_TOKEN), { clock, intervalMs: 60_000 }),
      warn: (message) => warnings.push(message),
    });

    await collector.collect();
    clock.advance(60_000);
    await collector.collect();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /stats collector failed/);
  });

  it("does not register technitium_stats_window_queries_by_type when includeQueryTypes is false", async () => {
    const registry = new Registry();
    const client = countingClient(STATS_FULL);
    await new StatsCollector(baseOptions(registry, client, { includeQueryTypes: false })).collect();

    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(
      metrics.find((m) => m.name === "technitium_stats_window_queries_by_type")?.values ?? [],
      [],
    );
  });

  it("exports the query-type split when includeQueryTypes is true", async () => {
    const registry = new Registry();
    const client = countingClient(STATS_FULL);
    await new StatsCollector(baseOptions(registry, client, { includeQueryTypes: true })).collect();

    const metrics = await registry.getMetricsAsJSON();
    const values =
      metrics.find((m) => m.name === "technitium_stats_window_queries_by_type")?.values ?? [];
    assert.ok(values.some((v) => v.labels.query_type === "A" && v.value === 50000));
  });
});
