import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Gauge, Registry } from "@prometheus-io/client";
import type { ClusterConfigDetail } from "../../../src/api/cluster.ts";
import {
  applyClusterConfigFailure,
  applyClusterConfigNotClustered,
  applyClusterConfigSuccess,
  createClusterMetrics,
} from "../../../src/metrics/cluster-metrics.ts";

async function valuesOf(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values ?? [];
}

function sharedCollectorSuccess(registry: Registry): Gauge<"collector"> {
  return new Gauge<"collector">({
    name: "technitium_collector_success",
    help: "Per-collector outcome of the last poll cycle",
    labelNames: ["collector"],
    registers: [registry],
  });
}

function detail(overrides: Partial<ClusterConfigDetail> = {}): ClusterConfigDetail {
  return {
    heartbeatRefreshIntervalSeconds: 30,
    heartbeatRetryIntervalSeconds: 10,
    configRefreshIntervalSeconds: 900,
    configLastSyncedSeconds: 1_700_000_000,
    ...overrides,
  };
}

describe("applyClusterConfigSuccess", () => {
  it("re-exports every interval field and the config-sync timestamp under its stable name", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigSuccess(metrics, detail());

    assert.equal(
      (await valuesOf(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"))[0]?.value,
      30,
    );
    assert.equal(
      (await valuesOf(registry, "technitium_cluster_heartbeat_retry_interval_seconds"))[0]?.value,
      10,
    );
    assert.equal(
      (await valuesOf(registry, "technitium_cluster_config_refresh_interval_seconds"))[0]?.value,
      900,
    );
    assert.equal(
      (await valuesOf(registry, "technitium_cluster_config_last_synced_timestamp_seconds"))[0]
        ?.value,
      1_700_000_000,
    );
  });

  it("sets collector_success to 1", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigSuccess(metrics, detail());

    assert.deepEqual(await valuesOf(registry, "technitium_collector_success"), [
      { value: 1, labels: { collector: "cluster" } },
    ]);
  });

  it("leaves a field's series genuinely absent, not present-and-zero, when it is undefined", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigSuccess(
      metrics,
      detail({ heartbeatRefreshIntervalSeconds: undefined, configLastSyncedSeconds: undefined }),
    );

    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      [],
    );
    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_config_last_synced_timestamp_seconds"),
      [],
    );
  });

  it("removes a field's series once a later successful cycle no longer reports it (never-sentinel replacing a real sync time)", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigSuccess(metrics, detail());
    assert.equal(
      (await valuesOf(registry, "technitium_cluster_config_last_synced_timestamp_seconds"))[0]
        ?.value,
      1_700_000_000,
    );

    applyClusterConfigSuccess(metrics, detail({ configLastSyncedSeconds: undefined }));

    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_config_last_synced_timestamp_seconds"),
      [],
    );
  });
});

describe("applyClusterConfigFailure", () => {
  it("sets collector_success to 0", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigFailure(metrics);

    assert.deepEqual(await valuesOf(registry, "technitium_collector_success"), [
      { value: 0, labels: { collector: "cluster" } },
    ]);
  });

  it("freezes an already-registered field at its last known value rather than clearing it", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigSuccess(metrics, detail());

    applyClusterConfigFailure(metrics);

    assert.equal(
      (await valuesOf(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"))[0]?.value,
      30,
    );
    assert.equal(
      (await valuesOf(registry, "technitium_cluster_config_last_synced_timestamp_seconds"))[0]
        ?.value,
      1_700_000_000,
    );
  });
});

describe("applyClusterConfigNotClustered", () => {
  it("clears every value field to genuinely absent, unlike applyClusterConfigFailure's freeze", async () => {
    const registry = new Registry();
    const metrics = createClusterMetrics(registry, sharedCollectorSuccess(registry));
    applyClusterConfigSuccess(metrics, detail());

    applyClusterConfigNotClustered(metrics);

    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      [],
    );
    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_config_last_synced_timestamp_seconds"),
      [],
    );
  });

  it("removes collector_success's own cluster child entirely, rather than setting it to 0", async () => {
    const registry = new Registry();
    const collectorSuccess = sharedCollectorSuccess(registry);
    const metrics = createClusterMetrics(registry, collectorSuccess);
    applyClusterConfigSuccess(metrics, detail());

    applyClusterConfigNotClustered(metrics);

    const success = await valuesOf(registry, "technitium_collector_success");
    assert.equal(
      success.some((v) => v.labels.collector === "cluster"),
      false,
    );
  });

  it("does not disturb another collector's own collector_success child sharing the same Gauge", async () => {
    const registry = new Registry();
    const collectorSuccess = sharedCollectorSuccess(registry);
    collectorSuccess.labels({ collector: "native" }).set(1);
    const metrics = createClusterMetrics(registry, collectorSuccess);
    applyClusterConfigSuccess(metrics, detail());

    applyClusterConfigNotClustered(metrics);

    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(
      success.find((v) => v.labels.collector === "native"),
      { value: 1, labels: { collector: "native" } },
    );
  });
});
