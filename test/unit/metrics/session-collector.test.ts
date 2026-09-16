import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { SessionCollector } from "../../../src/metrics/session-collector.ts";

const V15_CLUSTERED = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");
const PRE_V15 = readFileSync("test/fixtures/session/session-get-pre-v15.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");

function stubClient(body: string | (() => Promise<never>)) {
  return {
    get: async () => {
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
  };
}

async function upValue(registry: Registry): Promise<number | undefined> {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === "technitium_up")?.values[0]?.value;
}

function collector(
  registry: Registry,
  httpClient: { get: () => Promise<{ statusCode: number; body: string }> },
  overrides: { enabledCollectors?: readonly string[]; warn?: (message: string) => void } = {},
) {
  return new SessionCollector({
    httpClient,
    registry,
    enabledCollectors: overrides.enabledCollectors ?? [],
    warn: overrides.warn ?? (() => {}),
  });
}

describe("SessionCollector.collect", () => {
  it("sets technitium_up to 0 for an unreachable target", async () => {
    const registry = new Registry();
    const c = collector(
      registry,
      stubClient(() => {
        throw new TechnitiumHttpError("network", "connection refused");
      }),
    );

    const result = await c.collect();
    assert.equal(result.kind, "failure");
    assert.equal(await upValue(registry), 0);
  });

  it("sets technitium_up to 0 for a rejected token", async () => {
    const registry = new Registry();
    const c = collector(registry, stubClient(INVALID_TOKEN));

    const result = await c.collect();
    assert.equal(result.kind, "failure");
    assert.equal(await upValue(registry), 0);
  });

  it("sets technitium_up to 1 only on real success", async () => {
    const registry = new Registry();
    const c = collector(registry, stubClient(V15_CLUSTERED));

    const result = await c.collect();
    assert.equal(result.kind, "success");
    assert.equal(await upValue(registry), 1);
  });

  it("produces a four-value peer state set including Unknown for a clustered fixture", async () => {
    const registry = new Registry();
    const c = collector(registry, stubClient(V15_CLUSTERED));
    await c.collect();

    const metrics = await registry.getMetricsAsJSON();
    const stateValues =
      metrics.find((m) => m.name === "technitium_cluster_node_state")?.values ?? [];
    const observedStates = new Set(
      stateValues.filter((v) => v.value === 1).map((v) => v.labels.state),
    );
    assert.deepEqual(observedStates, new Set(["Self", "Connected", "Unreachable", "Unknown"]));
  });

  it("drops a peer removed between two poll cycles from the state set", async () => {
    const registry = new Registry();
    const raw = JSON.parse(V15_CLUSTERED) as { info: { clusterNodes: unknown[] } };
    const withoutD = {
      ...raw,
      info: {
        ...raw.info,
        clusterNodes: raw.info.clusterNodes.filter(
          (n) => (n as { name: string }).name !== "dns-d.example.com",
        ),
      },
    };

    // A single collector instance is reused across both poll cycles, exactly
    // as a real per-target poll loop would — its metrics are created once at
    // construction, not re-registered into the same registry every cycle.
    let currentBody = JSON.stringify(raw);
    const c = collector(registry, { get: async () => ({ statusCode: 200, body: currentBody }) });
    await c.collect();

    let metrics = await registry.getMetricsAsJSON();
    let stateValues = metrics.find((m) => m.name === "technitium_cluster_node_state")?.values ?? [];
    assert.ok(stateValues.some((v) => v.labels.node_name === "dns-d.example.com"));

    currentBody = JSON.stringify(withoutD);
    await c.collect();

    metrics = await registry.getMetricsAsJSON();
    stateValues = metrics.find((m) => m.name === "technitium_cluster_node_state")?.values ?? [];
    assert.equal(
      stateValues.some((v) => v.labels.node_name === "dns-d.example.com"),
      false,
    );
  });

  it("produces none of the three peer metrics for a non-clustered fixture", async () => {
    const registry = new Registry();
    const c = collector(registry, stubClient(PRE_V15));
    await c.collect();

    const metrics = await registry.getMetricsAsJSON();
    for (const name of [
      "technitium_cluster_node_state",
      "technitium_cluster_node_last_seen_timestamp_seconds",
      "technitium_cluster_nodes",
    ]) {
      // technitium_cluster_nodes has no label dimension, so a genuinely
      // absent series means the metric is never registered at all, not
      // registered-with-an-empty-values-array — both collapse to [] here.
      assert.deepEqual(metrics.find((m) => m.name === name)?.values ?? [], []);
    }
  });

  it("warns once on repeated failures, then warns again after a recovery", async () => {
    const registry = new Registry();
    const warnings: string[] = [];
    let mode: "fail" | "succeed" = "fail";
    const c = collector(
      registry,
      {
        get: async () => {
          if (mode === "fail") throw new TechnitiumHttpError("network", "connection refused");
          return { statusCode: 200, body: V15_CLUSTERED };
        },
      },
      { warn: (message) => warnings.push(message) },
    );

    await c.collect();
    await c.collect();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /session collector failed/);

    mode = "succeed";
    const recovered = await c.collect();
    assert.equal(recovered.kind, "success");
    assert.equal(warnings.length, 1);

    mode = "fail";
    await c.collect();
    assert.equal(warnings.length, 2);
    assert.match(warnings[1] ?? "", /session collector failed/);
  });

  it("warns once and marks an enabled collector missing its permission as skipped", async () => {
    const registry = new Registry();
    const warnings: string[] = [];
    const c = collector(registry, stubClient(V15_CLUSTERED), {
      enabledCollectors: ["cluster"],
      warn: (message) => warnings.push(message),
    });

    await c.collect();
    await c.collect();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /cluster.*Administration/);

    const metrics = await registry.getMetricsAsJSON();
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    const clusterSuccess = success.find((v) => v.labels.collector === "cluster");
    assert.equal(clusterSuccess?.value, 0);
  });

  it("warns again after a permission is granted and then revoked a second time", async () => {
    const registry = new Registry();
    const warnings: string[] = [];
    const raw = JSON.parse(V15_CLUSTERED) as {
      info: { permissions: Record<string, { canView: boolean }> };
    };
    let currentBody = JSON.stringify(raw);
    const c = collector(
      registry,
      { get: async () => ({ statusCode: 200, body: currentBody }) },
      { enabledCollectors: ["cluster"], warn: (message) => warnings.push(message) },
    );

    await c.collect();
    assert.equal(warnings.length, 1);

    raw.info.permissions.Administration = { canView: true };
    currentBody = JSON.stringify(raw);
    await c.collect();
    assert.equal(warnings.length, 1);

    raw.info.permissions.Administration = { canView: false };
    currentBody = JSON.stringify(raw);
    await c.collect();
    assert.equal(warnings.length, 2);
  });

  it("does not gate a collector whose required permission is granted", async () => {
    const registry = new Registry();
    const warnings: string[] = [];
    const c = collector(registry, stubClient(V15_CLUSTERED), {
      enabledCollectors: ["native"],
      warn: (message) => warnings.push(message),
    });

    await c.collect();

    assert.equal(warnings.length, 0);
    const metrics = await registry.getMetricsAsJSON();
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.equal(
      success.some((v) => v.labels.collector === "native"),
      false,
    );
  });
});
