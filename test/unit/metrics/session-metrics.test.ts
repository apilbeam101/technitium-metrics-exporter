import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import type { SessionInfo } from "../../../src/api/session.ts";
import {
  applySessionFailure,
  applySessionSuccess,
  createSessionMetrics,
} from "../../../src/metrics/session-metrics.ts";

async function valuesOf(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === name);
  assert.ok(metric, `no metric registered named ${name}`);
  return metric.values;
}

// technitium_cluster_nodes has no label dimension, so an absent series can
// only be achieved by not registering it at all (ClusterNodeCountGauge) — it
// may legitimately be missing from the registry entirely, unlike the always-
// registered metrics valuesOf() above asserts on.
async function valuesOfIfPresent(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values ?? [];
}

function permissions(
  overrides: Readonly<Record<string, boolean>> = {},
): SessionInfo["permissions"] {
  const sections = [
    "Dashboard",
    "Zones",
    "Cache",
    "Allowed",
    "Blocked",
    "Apps",
    "DnsClient",
    "DhcpServer",
    "Logs",
    "Administration",
    "Settings",
  ];
  const result: Record<string, { canView: boolean; canModify: boolean; canDelete: boolean }> = {};
  for (const section of sections) {
    result[section] = { canView: overrides[section] ?? false, canModify: false, canDelete: false };
  }
  return result;
}

function baseInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    version: "15.4",
    dnsServerDomain: "dns-a.example.com",
    clusterInitialized: false,
    permissions: permissions(),
    clusterPeers: undefined,
    ...overrides,
  };
}

describe("applySessionFailure", () => {
  it("sets up and the session collector_success to 0", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionFailure(metrics);

    assert.deepEqual((await valuesOf(registry, "technitium_up"))[0]?.value, 0);
    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(success, [{ value: 0, labels: { collector: "session" } }]);
  });

  it("clears the peer state set, last-seen gauge and node count after a prior success", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);

    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          { name: "dns-a.example.com", type: "Primary", state: "Self", lastSeenSeconds: undefined },
          {
            name: "dns-b.example.com",
            type: "Secondary",
            state: "Connected",
            lastSeenSeconds: 1000,
          },
        ],
      }),
    );
    assert.equal((await valuesOf(registry, "technitium_cluster_nodes"))[0]?.value, 2);

    applySessionFailure(metrics);

    assert.deepEqual(await valuesOf(registry, "technitium_cluster_node_state"), []);
    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_node_last_seen_timestamp_seconds"),
      [],
    );
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_cluster_nodes"), []);
  });
});

describe("applySessionSuccess", () => {
  it("sets up and the session collector_success to 1 only on success", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionSuccess(metrics, baseInfo());

    assert.equal((await valuesOf(registry, "technitium_up"))[0]?.value, 1);
    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(success, [{ value: 1, labels: { collector: "session" } }]);
  });

  it("exports cluster_initialized as 0 or 1 depending on the parsed flag", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);

    applySessionSuccess(metrics, baseInfo({ clusterInitialized: false }));
    assert.equal((await valuesOf(registry, "technitium_cluster_initialized"))[0]?.value, 0);

    applySessionSuccess(metrics, baseInfo({ clusterInitialized: true, clusterPeers: [] }));
    assert.equal((await valuesOf(registry, "technitium_cluster_initialized"))[0]?.value, 1);
  });

  it("exports permission_granted for every documented section from canView alone", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionSuccess(
      metrics,
      baseInfo({ permissions: permissions({ Dashboard: true, Zones: true }) }),
    );

    const values = await valuesOf(registry, "technitium_permission_granted");
    assert.equal(values.length, 11);
    const bySection = new Map(values.map((v) => [v.labels.section, v.value]));
    assert.equal(bySection.get("Dashboard"), 1);
    assert.equal(bySection.get("Zones"), 1);
    assert.equal(bySection.get("Administration"), 0);
  });

  it("produces none of the three cluster peer metrics for a non-clustered target", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionSuccess(metrics, baseInfo({ clusterInitialized: false, clusterPeers: undefined }));

    assert.deepEqual(await valuesOf(registry, "technitium_cluster_node_state"), []);
    assert.deepEqual(
      await valuesOf(registry, "technitium_cluster_node_last_seen_timestamp_seconds"),
      [],
    );
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_cluster_nodes"), []);
  });

  it("produces a four-value peer state set, including Unknown, for a clustered target", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          { name: "dns-a.example.com", type: "Primary", state: "Self", lastSeenSeconds: undefined },
          {
            name: "dns-b.example.com",
            type: "Secondary",
            state: "Connected",
            lastSeenSeconds: 1000,
          },
          {
            name: "dns-c.example.com",
            type: "Secondary",
            state: "Unreachable",
            lastSeenSeconds: 2000,
          },
          {
            name: "dns-d.example.com",
            type: "Secondary",
            state: "Unknown",
            lastSeenSeconds: undefined,
          },
        ],
      }),
    );

    const stateValues = await valuesOf(registry, "technitium_cluster_node_state");
    const observedStates = new Set(
      stateValues.filter((v) => v.value === 1).map((v) => v.labels.state),
    );
    assert.deepEqual(observedStates, new Set(["Self", "Connected", "Unreachable", "Unknown"]));

    // Exactly one series set to 1 per peer, the rest 0 (D§3.3's state set).
    const byPeer = new Map<string, number>();
    for (const v of stateValues) {
      if (v.value === 1)
        byPeer.set(
          v.labels.node_name as string,
          (byPeer.get(v.labels.node_name as string) ?? 0) + 1,
        );
    }
    for (const count of byPeer.values()) assert.equal(count, 1);

    assert.equal((await valuesOf(registry, "technitium_cluster_nodes"))[0]?.value, 4);

    const lastSeen = await valuesOf(
      registry,
      "technitium_cluster_node_last_seen_timestamp_seconds",
    );
    const lastSeenByName = new Map(lastSeen.map((v) => [v.labels.node_name, v.value]));
    assert.equal(lastSeenByName.has("dns-a.example.com"), false);
    assert.equal(lastSeenByName.get("dns-b.example.com"), 1000);
    assert.equal(lastSeenByName.get("dns-c.example.com"), 2000);
    assert.equal(lastSeenByName.has("dns-d.example.com"), false);
  });

  it("removes a peer's series entirely once it disappears from a later poll", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);

    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          { name: "dns-a.example.com", type: "Primary", state: "Self", lastSeenSeconds: undefined },
          {
            name: "dns-b.example.com",
            type: "Secondary",
            state: "Connected",
            lastSeenSeconds: 1000,
          },
        ],
      }),
    );
    assert.equal((await valuesOf(registry, "technitium_cluster_nodes"))[0]?.value, 2);

    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          { name: "dns-a.example.com", type: "Primary", state: "Self", lastSeenSeconds: undefined },
        ],
      }),
    );

    const stateValues = await valuesOf(registry, "technitium_cluster_node_state");
    assert.equal(
      stateValues.some((v) => v.labels.node_name === "dns-b.example.com"),
      false,
    );
    const lastSeen = await valuesOf(
      registry,
      "technitium_cluster_node_last_seen_timestamp_seconds",
    );
    assert.equal(
      lastSeen.some((v) => v.labels.node_name === "dns-b.example.com"),
      false,
    );
    assert.equal((await valuesOf(registry, "technitium_cluster_nodes"))[0]?.value, 1);
  });

  it("counts an unrecognized peer state without breaking the render, and still emits all four known-state series at 0", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          {
            name: "dns-e.example.com",
            type: "Primary",
            state: "Rebalancing",
            lastSeenSeconds: undefined,
          },
        ],
      }),
    );

    const stateValues = await valuesOf(registry, "technitium_cluster_node_state");
    assert.equal(stateValues.length, 4);
    assert.ok(stateValues.every((v) => v.value === 0));

    const unknownEnum = await valuesOf(registry, "technitium_exporter_unknown_enum_total");
    assert.deepEqual(unknownEnum, [
      { value: 1, labels: { metric: "cluster_node_state", value: "Rebalancing" } },
    ]);
  });

  it("counts a genuinely absent peer state/type separately from an unrecognized one, via the (absent) tripwire value", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);
    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          {
            name: "dns-f.example.com",
            type: undefined,
            state: undefined,
            lastSeenSeconds: undefined,
          },
        ],
      }),
    );

    const unknownEnum = await valuesOf(registry, "technitium_exporter_unknown_enum_total");
    assert.deepEqual(
      new Set(unknownEnum.map((v) => JSON.stringify(v.labels))),
      new Set([
        JSON.stringify({ metric: "cluster_node_type", value: "(absent)" }),
        JSON.stringify({ metric: "cluster_node_state", value: "(absent)" }),
      ]),
    );

    const stateValues = await valuesOf(registry, "technitium_cluster_node_state");
    const peerValues = stateValues.filter((v) => v.labels.node_name === "dns-f.example.com");
    assert.equal(peerValues.length, 4);
    assert.ok(peerValues.every((v) => v.value === 0));
    assert.ok(peerValues.every((v) => v.labels.node_type === "(absent)"));
  });

  it("makes technitium_cluster_nodes genuinely absent (not 0) when a target loses clustering, then re-populates it", async () => {
    const registry = new Registry();
    const metrics = createSessionMetrics(registry);

    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          { name: "dns-a.example.com", type: "Primary", state: "Self", lastSeenSeconds: undefined },
          {
            name: "dns-b.example.com",
            type: "Secondary",
            state: "Connected",
            lastSeenSeconds: 1000,
          },
        ],
      }),
    );
    assert.equal((await valuesOf(registry, "technitium_cluster_nodes"))[0]?.value, 2);

    applySessionSuccess(metrics, baseInfo({ clusterInitialized: false, clusterPeers: undefined }));
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_cluster_nodes"), []);

    applySessionSuccess(
      metrics,
      baseInfo({
        clusterInitialized: true,
        clusterPeers: [
          { name: "dns-a.example.com", type: "Primary", state: "Self", lastSeenSeconds: undefined },
        ],
      }),
    );
    assert.equal((await valuesOf(registry, "technitium_cluster_nodes"))[0]?.value, 1);
  });
});
