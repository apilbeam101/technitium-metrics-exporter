import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Gauge, Registry } from "@prometheus-io/client";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { ClusterCollector } from "../../../src/metrics/cluster-collector.ts";
import { FakeClock } from "../../support/fake-clock.ts";

const CLUSTER_STATE = readFileSync("test/fixtures/cluster/cluster-state.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");

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

function countingClient(body: string | (() => Promise<never>)) {
  let calls = 0;
  return {
    get: async () => {
      calls++;
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
    get calls() {
      return calls;
    },
  };
}

describe("ClusterCollector.collect", () => {
  it("applies the cluster-configuration-detail metrics on a successful first cycle", async () => {
    const registry = new Registry();
    const result = await new ClusterCollector({
      httpClient: countingClient(CLUSTER_STATE),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock: new FakeClock(),
      intervalMs: 60_000,
      warn: () => {},
    }).collect();

    assert.equal(result.kind, "success");
    assert.equal(
      await valueOfMetric(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      30,
    );
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 1);
  });

  it("sets collector_success to 0 for an unreachable target, without ever having applied a value", async () => {
    const registry = new Registry();
    const result = await new ClusterCollector({
      httpClient: countingClient(() => {
        throw new TechnitiumHttpError("network", "connection refused");
      }),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock: new FakeClock(),
      intervalMs: 60_000,
      warn: () => {},
    }).collect();

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.equal(result.reason, "network");
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 0);
    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(
      metrics.find((m) => m.name === "technitium_cluster_heartbeat_refresh_interval_seconds")
        ?.values ?? [],
      [],
    );
  });

  it("does not re-fetch on a second cycle before the configured interval has elapsed, and reports fresh: false for it", async () => {
    const registry = new Registry();
    const client = countingClient(CLUSTER_STATE);
    const clock = new FakeClock();
    const collector = new ClusterCollector({
      httpClient: client,
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock,
      intervalMs: 60_000,
      warn: () => {},
    });

    const first = await collector.collect();
    clock.advance(30_000);
    const second = await collector.collect();

    assert.equal(client.calls, 1);
    assert.equal(first.fresh, true);
    assert.equal(second.fresh, false);
  });

  it("re-fetches once the configured interval has elapsed, and reports fresh: true for that cycle", async () => {
    const registry = new Registry();
    const client = countingClient(CLUSTER_STATE);
    const clock = new FakeClock();
    const collector = new ClusterCollector({
      httpClient: client,
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock,
      intervalMs: 60_000,
      warn: () => {},
    });

    await collector.collect();
    clock.advance(60_000);
    const second = await collector.collect();

    assert.equal(client.calls, 2);
    assert.equal(second.fresh, true);
  });

  it("freezes the last known interval values while collector_success drops to 0 on a subsequent failed fetch", async () => {
    const registry = new Registry();
    let mode: "succeed" | "fail" = "succeed";
    const clock = new FakeClock();
    const collector = new ClusterCollector({
      httpClient: {
        get: async () => {
          if (mode === "fail") throw new TechnitiumHttpError("network", "connection refused");
          return { statusCode: 200, body: CLUSTER_STATE };
        },
      },
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock,
      intervalMs: 60_000,
      warn: () => {},
    });

    await collector.collect();
    assert.equal(
      await valueOfMetric(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      30,
    );

    mode = "fail";
    clock.advance(60_000);
    const result = await collector.collect();

    assert.equal(result.kind, "failure");
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 0);
    assert.equal(
      await valueOfMetric(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      30,
    );
  });

  it("reports the last actual fetch's outcome on an off-cadence cycle, not a default, and marks that cycle fresh: false", async () => {
    const registry = new Registry();
    const clock = new FakeClock();
    const collector = new ClusterCollector({
      httpClient: countingClient(() => {
        throw new TechnitiumHttpError("auth", "invalid token");
      }),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock,
      intervalMs: 60_000,
      warn: () => {},
    });

    await collector.collect();
    clock.advance(1_000);
    const result = await collector.collect();

    assert.equal(result.kind, "failure");
    assert.equal(result.fresh, false);
    if (result.kind === "failure") assert.equal(result.reason, "auth");
  });

  it("notClustered() clears every value field and removes collector_success's own cluster child, without touching other collectors' series", async () => {
    const registry = new Registry();
    const otherSuccess = sharedCollectorSuccess(registry);
    otherSuccess.labels({ collector: "native" }).set(1);
    const collector = new ClusterCollector({
      httpClient: countingClient(CLUSTER_STATE),
      registry,
      collectorSuccess: otherSuccess,
      clock: new FakeClock(),
      intervalMs: 60_000,
      warn: () => {},
    });

    await collector.collect();
    assert.equal(
      await valueOfMetric(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      30,
    );

    collector.notClustered();

    const metrics = await registry.getMetricsAsJSON();
    assert.deepEqual(
      metrics.find((m) => m.name === "technitium_cluster_heartbeat_refresh_interval_seconds")
        ?.values ?? [],
      [],
    );
    assert.deepEqual(
      metrics.find((m) => m.name === "technitium_cluster_config_last_synced_timestamp_seconds")
        ?.values ?? [],
      [],
    );
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.equal(
      success.some((v) => v.labels.collector === "cluster"),
      false,
    );
    assert.ok(success.some((v) => v.labels.collector === "native" && v.value === 1));
  });

  it("warns once on the transition into failure, not on every failing cycle", async () => {
    const registry = new Registry();
    const warnings: string[] = [];
    const clock = new FakeClock();
    const collector = new ClusterCollector({
      httpClient: countingClient(INVALID_TOKEN),
      registry,
      collectorSuccess: sharedCollectorSuccess(registry),
      clock,
      intervalMs: 60_000,
      warn: (message) => warnings.push(message),
    });

    await collector.collect();
    clock.advance(60_000);
    await collector.collect();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /cluster collector failed/);
  });
});
