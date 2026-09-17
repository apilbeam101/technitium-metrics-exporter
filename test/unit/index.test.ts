import assert from "node:assert/strict";
import { Server } from "node:http";
import { describe, it } from "node:test";
import { Secret } from "../../src/config/secret.ts";
import type { AppConfig } from "../../src/config/types.ts";
import { afterListen, buildGlobalRegistry } from "../../src/index.ts";
import type { StartedServer } from "../../src/server/server.ts";

function baseConfig(targetCount: number): AppConfig {
  return {
    targets: Array.from({ length: targetCount }, (_, i) => ({
      name: `dns-${i}`,
      baseUrl: `https://dns-${i}.example.com`,
      apiToken: new Secret("x"),
      caBundlePath: undefined,
      tlsInsecureSkipVerify: false,
    })),
    metricsPort: 10153,
    metricsBindAddress: "0.0.0.0",
    pollIntervalSeconds: 30,
    clusterPollIntervalSeconds: 60,
    statsPollIntervalSeconds: 300,
    requestTimeoutSeconds: 15,
    enableClusterCollector: false,
    enableStatsCollector: false,
    enableStatsQueryTypes: false,
    zonesIncludeInternal: false,
    enableDefaultMetrics: false,
    logLevel: "info",
    logFormat: "json",
    metricsTls: undefined,
  };
}

async function metricNamesAndValue(
  registry: { getMetricsAsJSON: () => Promise<unknown> },
  name: string,
) {
  const metrics = (await registry.getMetricsAsJSON()) as Array<{
    name: string;
    values: Array<{ value: number; labels: Record<string, unknown> }>;
  }>;
  return { names: metrics.map((m) => m.name), entry: metrics.find((m) => m.name === name) };
}

describe("buildGlobalRegistry", () => {
  it("exposes only global series — build info and target count — never per-target data", async () => {
    const registry = buildGlobalRegistry(baseConfig(2), {
      version: "1.2.3",
      commit: "abc1234",
      nodeVersion: "v24.0.0",
    });

    const { names, entry: targets } = await metricNamesAndValue(
      registry,
      "technitium_exporter_targets",
    );

    assert.deepEqual(
      [...names].sort(),
      ["technitium_exporter_build_info", "technitium_exporter_targets"].sort(),
    );
    assert.equal(targets?.values[0]?.value, 2);

    const { entry: buildInfo } = await metricNamesAndValue(
      registry,
      "technitium_exporter_build_info",
    );
    assert.equal(buildInfo?.values[0]?.value, 1);
    assert.deepEqual(buildInfo?.values[0]?.labels, {
      version: "1.2.3",
      commit: "abc1234",
      node_version: "v24.0.0",
    });
  });

  it("counts zero configured targets honestly", async () => {
    const registry = buildGlobalRegistry(baseConfig(0), {
      version: "0.0.0",
      commit: "unknown",
      nodeVersion: process.version,
    });
    const { entry: targets } = await metricNamesAndValue(registry, "technitium_exporter_targets");
    assert.equal(targets?.values[0]?.value, 0);
  });
});

describe("afterListen", () => {
  it("closes the just-opened server and rethrows when build() throws", async () => {
    let closed = false;
    const started: StartedServer = {
      server: new Server(),
      close: async () => {
        closed = true;
      },
    };

    await assert.rejects(
      afterListen(started, () => {
        throw new Error("target registry construction failed");
      }),
      /target registry construction failed/,
    );
    assert.equal(closed, true);
  });

  it("closes the server and rethrows when an async build() rejects", async () => {
    let closed = false;
    const started: StartedServer = {
      server: new Server(),
      close: async () => {
        closed = true;
      },
    };

    await assert.rejects(
      afterListen(started, async () => {
        throw new Error("async failure");
      }),
      /async failure/,
    );
    assert.equal(closed, true);
  });

  it("does not close the server and returns the built value on success", async () => {
    let closed = false;
    const started: StartedServer = {
      server: new Server(),
      close: async () => {
        closed = true;
      },
    };

    const result = await afterListen(started, () => 42);
    assert.equal(result, 42);
    assert.equal(closed, false);
  });
});
