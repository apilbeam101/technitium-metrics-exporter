import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Secret } from "../../../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../../../src/config/types.ts";
import { type PollErrorReason, TechnitiumHttpError } from "../../../src/http/errors.ts";
import type { TargetEntry } from "../../../src/poller/target-registry.ts";
import { runTargetCycle, TargetRegistry } from "../../../src/poller/target-registry.ts";
import { FakeClock } from "../../support/fake-clock.ts";

function mustGet(registry: TargetRegistry, name: string): TargetEntry {
  const entry = registry.get(name);
  assert.notEqual(entry, undefined, `expected target "${name}" to exist`);
  return entry as TargetEntry;
}

const SESSION_V15_CLUSTERED = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");
const NATIVE_CURRENT = readFileSync("test/fixtures/native/metrics-text-current-names.txt", "utf8");
const ZONES_LIST = readFileSync("test/fixtures/zones/zones-list.json", "utf8");
const CLUSTER_STATE = readFileSync("test/fixtures/cluster/cluster-state.json", "utf8");
const STATS_FULL = readFileSync("test/fixtures/stats/stats-get-full.json", "utf8");

// SESSION_V15_CLUSTERED's own fixture token has Administration: View denied
// (it's the fixture native/zones tests already share), so the
// cluster-collector wiring tests need their own copy with that grant added.
const SESSION_V15_ADMIN_GRANTED = (() => {
  const raw = JSON.parse(SESSION_V15_CLUSTERED) as {
    info: { permissions: Record<string, { canView: boolean }> };
  };
  raw.info.permissions.Administration = { canView: true };
  return JSON.stringify(raw);
})();

function target(name: string): TargetConfig {
  return {
    name,
    baseUrl: `https://${name}.example.com`,
    apiToken: new Secret("token"),
    caBundlePath: undefined,
    tlsInsecureSkipVerify: false,
  };
}

function baseConfig(
  targets: readonly TargetConfig[],
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    targets,
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
    ...overrides,
  };
}

// Routes a fake HttpClient's get() by path, mirroring the real endpoints
// each collector calls, rather than the single-response stubs the existing
// collector-level tests use (those only ever call one endpoint each).
function routedClient(routes: Readonly<Record<string, string | (() => Promise<never>)>>): {
  get: (path: string) => Promise<{ statusCode: number; body: string }>;
} {
  return {
    get: async (path: string) => {
      const body = routes[path];
      if (body === undefined) throw new Error(`unstubbed path: ${path}`);
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
  };
}

async function metricValue(registry: { getMetricsAsJSON: () => Promise<unknown> }, name: string) {
  const metrics = (await registry.getMetricsAsJSON()) as Array<{
    name: string;
    values: Array<{ value: number }>;
  }>;
  return metrics.find((m) => m.name === name)?.values[0]?.value;
}

// Same routing as routedClient, but records every call by path so a test can
// assert a given endpoint was never reached at all — routedClient throwing
// on an unstubbed path only proves that a call to it, if made, wouldn't have
// been served a real fixture; it does not prove no call was attempted, since
// createRefreshCache's own catch would swallow that thrown error into an
// ordinary failure outcome indistinguishable from the collector never having
// been invoked.
function trackedRoutedClient(routes: Readonly<Record<string, string | (() => Promise<never>)>>): {
  get: (path: string) => Promise<{ statusCode: number; body: string }>;
  callsFor(path: string): number;
} {
  const calls = new Map<string, number>();
  return {
    get: async (path: string) => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      const body = routes[path];
      if (body === undefined) throw new Error(`unstubbed path: ${path}`);
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
    callsFor: (path: string) => calls.get(path) ?? 0,
  };
}

describe("TargetRegistry", () => {
  it("creates one isolated entry per configured target", () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a"), target("dns-b")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () => routedClient({}),
    });

    assert.deepEqual([...registry.names].sort(), ["dns-a", "dns-b"]);
    const a = registry.get("dns-a");
    const b = registry.get("dns-b");
    assert.notEqual(a, undefined);
    assert.notEqual(b, undefined);
    assert.notEqual(a?.registry, b?.registry);
  });

  it("returns undefined for an unknown target name", () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () => routedClient({}),
    });

    assert.equal(registry.get("dns-nope"), undefined);
  });

  it("is ready with zero configured targets", () => {
    const registry = new TargetRegistry(baseConfig([]), {
      clock: new FakeClock(),
      warn: () => {},
    });
    assert.equal(registry.allTargetsReady, true);
  });

  it("is not ready until every target has completed at least one cycle", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a"), target("dns-b")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: (t) =>
        routedClient({
          "/api/user/session/get": () => {
            throw new TechnitiumHttpError("network", `${t.name} unreachable`);
          },
        }),
    });

    assert.equal(registry.allTargetsReady, false);

    await registry.get("dns-a")?.runCycle();
    assert.equal(registry.allTargetsReady, false);

    await registry.get("dns-b")?.runCycle();
    assert.equal(registry.allTargetsReady, true);
  });

  it("counts a failed cycle as completed, not just a successful one (N3)", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () =>
        routedClient({
          "/api/user/session/get": INVALID_TOKEN,
        }),
    });

    await mustGet(registry, "dns-a").runCycle();
    assert.equal(registry.allTargetsReady, true);
    assert.equal(await metricValue(mustGet(registry, "dns-a").registry, "technitium_up"), 0);
  });

  it("sets technitium_up to 1 and runs native/zones on a fully successful cycle", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () =>
        routedClient({
          "/api/user/session/get": SESSION_V15_CLUSTERED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
        }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(await metricValue(entry.registry, "technitium_up"), 1);
    assert.notEqual(await metricValue(entry.registry, "technitium_zones_visible"), undefined);
    assert.notEqual(await metricValue(entry.registry, "technitium_queries_total"), undefined);
  });

  it("leaves one target's series intact when another target is hard down (N3)", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a"), target("dns-b")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: (t) =>
        t.name === "dns-a"
          ? routedClient({
              "/api/user/session/get": SESSION_V15_CLUSTERED,
              "/api/dashboard/metrics/text": NATIVE_CURRENT,
              "/api/zones/list": ZONES_LIST,
            })
          : routedClient({
              "/api/user/session/get": () => {
                throw new TechnitiumHttpError("network", "dns-b unreachable");
              },
            }),
    });

    await Promise.all([
      mustGet(registry, "dns-a").runCycle(),
      mustGet(registry, "dns-b").runCycle(),
    ]);

    assert.equal(await metricValue(mustGet(registry, "dns-a").registry, "technitium_up"), 1);
    assert.equal(await metricValue(mustGet(registry, "dns-b").registry, "technitium_up"), 0);
  });

  it("runs the cluster collector when enabled and Administration: View is granted", async () => {
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableClusterCollector: true }),
      {
        clock: new FakeClock(),
        warn: () => {},
        createHttpClient: () =>
          routedClient({
            "/api/user/session/get": SESSION_V15_ADMIN_GRANTED,
            "/api/dashboard/metrics/text": NATIVE_CURRENT,
            "/api/zones/list": ZONES_LIST,
            "/api/admin/cluster/state": CLUSTER_STATE,
          }),
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(
      await metricValue(entry.registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      30,
    );
    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.ok(success.some((v) => v.labels.collector === "cluster" && v.value === 1));
  });

  it("auto-skips the cluster collector when Administration: View is absent, without ever calling admin/cluster/state or disturbing the session-sourced peer state set (D§4.4)", async () => {
    const warnings: string[] = [];
    const client = trackedRoutedClient({
      "/api/user/session/get": SESSION_V15_CLUSTERED,
      "/api/dashboard/metrics/text": NATIVE_CURRENT,
      "/api/zones/list": ZONES_LIST,
    });
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableClusterCollector: true }),
      {
        clock: new FakeClock(),
        warn: (_targetName, message) => warnings.push(message),
        createHttpClient: () => client,
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(client.callsFor("/api/admin/cluster/state"), 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /cluster.*Administration/);

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.deepEqual(
      success.find((v) => v.labels.collector === "cluster"),
      { value: 0, labels: { collector: "cluster" } },
    );
    // Phase 4's peer state set rides session/get with no permission at all,
    // so it must still be present even though the config-detail collector
    // was skipped.
    const peerState = metrics.find((m) => m.name === "technitium_cluster_node_state")?.values ?? [];
    assert.ok(peerState.length > 0);
  });

  it("never registers a cluster collector_success series when ENABLE_CLUSTER_COLLECTOR is off, but still exposes the session-sourced peer state set", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () =>
        routedClient({
          "/api/user/session/get": SESSION_V15_ADMIN_GRANTED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
        }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.equal(
      success.some((v) => v.labels.collector === "cluster"),
      false,
    );
    const peerState = metrics.find((m) => m.name === "technitium_cluster_node_state")?.values ?? [];
    assert.ok(peerState.length > 0);
  });

  it("with ENABLE_CLUSTER_COLLECTOR off and Administration: View also absent (the common least-privilege deployment), never warns about the cluster collector at all", async () => {
    const warnings: string[] = [];
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: (_targetName, message) => warnings.push(message),
      createHttpClient: () =>
        routedClient({
          "/api/user/session/get": SESSION_V15_CLUSTERED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
        }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(
      warnings.some((w) => /cluster/i.test(w)),
      false,
    );
  });

  it("never calls admin/cluster/state, without warning, for a target that has never been clustered", async () => {
    const raw = JSON.parse(SESSION_V15_ADMIN_GRANTED) as {
      info: { clusterInitialized: boolean };
    };
    raw.info.clusterInitialized = false;
    const nonClustered = JSON.stringify(raw);

    const warnings: string[] = [];
    const client = trackedRoutedClient({
      "/api/user/session/get": nonClustered,
      "/api/dashboard/metrics/text": NATIVE_CURRENT,
      "/api/zones/list": ZONES_LIST,
    });
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableClusterCollector: true }),
      {
        clock: new FakeClock(),
        warn: (_targetName, message) => warnings.push(message),
        createHttpClient: () => client,
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(client.callsFor("/api/admin/cluster/state"), 0);
    assert.equal(warnings.length, 0);
    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.equal(
      success.some((v) => v.labels.collector === "cluster"),
      false,
    );
  });

  it("clears the four config-detail series and the cluster collector_success child, rather than freezing them at a stale value, once a previously-clustered target loses clustering", async () => {
    const clusteredSession = SESSION_V15_ADMIN_GRANTED;
    const raw = JSON.parse(SESSION_V15_ADMIN_GRANTED) as {
      info: { clusterInitialized: boolean };
    };
    raw.info.clusterInitialized = false;
    const nowNonClustered = JSON.stringify(raw);

    let sessionBody = clusteredSession;
    // Routes session/get through a mutable body so it can change between
    // cycles while every other route stays fixed on the plain routedClient.
    const client = {
      get: (path: string) =>
        path === "/api/user/session/get"
          ? Promise.resolve({ statusCode: 200, body: sessionBody })
          : routedClient({
              "/api/dashboard/metrics/text": NATIVE_CURRENT,
              "/api/zones/list": ZONES_LIST,
              "/api/admin/cluster/state": CLUSTER_STATE,
            }).get(path),
    };
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableClusterCollector: true }),
      {
        clock: new FakeClock(),
        warn: () => {},
        createHttpClient: () => client,
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();
    assert.equal(
      await metricValue(entry.registry, "technitium_cluster_heartbeat_refresh_interval_seconds"),
      30,
    );

    sessionBody = nowNonClustered;
    await entry.runCycle();

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    assert.deepEqual(
      metrics.find((m) => m.name === "technitium_cluster_heartbeat_refresh_interval_seconds")
        ?.values ?? [],
      [],
    );
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.equal(
      success.some((v) => v.labels.collector === "cluster"),
      false,
    );
  });

  it("counts a cluster parse failure exactly once, not again on a later off-cadence cycle that merely restates it", async () => {
    const clock = new FakeClock();
    const client = trackedRoutedClient({
      "/api/user/session/get": SESSION_V15_ADMIN_GRANTED,
      "/api/dashboard/metrics/text": NATIVE_CURRENT,
      "/api/zones/list": ZONES_LIST,
      "/api/admin/cluster/state": "not valid json",
    });
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], {
        enableClusterCollector: true,
        clusterPollIntervalSeconds: 60,
      }),
      {
        clock,
        warn: () => {},
        createHttpClient: () => client,
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();
    assert.equal(entry.pollTracker.parseErrorCycles, 1);

    // Well inside the 60s cluster cadence, so the second cycle's own
    // refreshIfDue() is a no-op and cluster.collect() only restates the
    // first cycle's already-counted parse failure.
    clock.advance(1_000);
    await entry.runCycle();

    assert.equal(entry.pollTracker.parseErrorCycles, 1);
  });

  it("runs the stats collector when enabled and Dashboard: View is granted", async () => {
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableStatsCollector: true }),
      {
        clock: new FakeClock(),
        warn: () => {},
        createHttpClient: () =>
          routedClient({
            "/api/user/session/get": SESSION_V15_CLUSTERED,
            "/api/dashboard/metrics/text": NATIVE_CURRENT,
            "/api/zones/list": ZONES_LIST,
            "/api/dashboard/stats/get": STATS_FULL,
          }),
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(await metricValue(entry.registry, "technitium_zones_reported"), 11);
    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.ok(success.some((v) => v.labels.collector === "stats" && v.value === 1));
  });

  it("never registers a stats collector_success series when ENABLE_STATS_COLLECTOR is off", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () =>
        routedClient({
          "/api/user/session/get": SESSION_V15_CLUSTERED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
        }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.equal(
      success.some((v) => v.labels.collector === "stats"),
      false,
    );
  });

  it("auto-skips the stats collector when Dashboard: View is absent, without ever calling stats/get", async () => {
    const warnings: string[] = [];
    const raw = JSON.parse(SESSION_V15_CLUSTERED) as {
      info: { permissions: Record<string, { canView: boolean }> };
    };
    raw.info.permissions.Dashboard = { canView: false };
    const noDashboard = JSON.stringify(raw);

    const client = trackedRoutedClient({
      "/api/user/session/get": noDashboard,
      "/api/zones/list": ZONES_LIST,
    });
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableStatsCollector: true }),
      {
        clock: new FakeClock(),
        warn: (_targetName, message) => warnings.push(message),
        createHttpClient: () => client,
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(client.callsFor("/api/dashboard/stats/get"), 0);
    assert.ok(warnings.some((w) => /stats.*Dashboard/.test(w)));

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.deepEqual(
      success.find((v) => v.labels.collector === "stats"),
      { value: 0, labels: { collector: "stats" } },
    );
  });

  it("exports the query-type split when both ENABLE_STATS_COLLECTOR and ENABLE_STATS_QUERY_TYPES are on", async () => {
    const registry = new TargetRegistry(
      baseConfig([target("dns-a")], { enableStatsCollector: true, enableStatsQueryTypes: true }),
      {
        clock: new FakeClock(),
        warn: () => {},
        createHttpClient: () =>
          routedClient({
            "/api/user/session/get": SESSION_V15_CLUSTERED,
            "/api/dashboard/metrics/text": NATIVE_CURRENT,
            "/api/zones/list": ZONES_LIST,
            "/api/dashboard/stats/get": STATS_FULL,
          }),
      },
    );

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const values =
      metrics.find((m) => m.name === "technitium_stats_window_queries_by_type")?.values ?? [];
    assert.ok(values.length > 0);
  });

  it("records fetchedAt from the monotonic clock, not wall time", async () => {
    // initialNowMs seeds FakeClock's now() far from 0 while its elapsed()
    // (the monotonic counter) starts at 0 regardless, so a fetchedAt of 0
    // proves record() was given clock.elapsed() rather than clock.now().
    const clock = new FakeClock(1_700_000_000_000);
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock,
      warn: () => {},
      createHttpClient: () => routedClient({ "/api/user/session/get": INVALID_TOKEN }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(entry.pollTracker.lastEntry?.fetchedAt, clock.elapsed());
    assert.notEqual(entry.pollTracker.lastEntry?.fetchedAt, clock.now());
  });

  it("sets technitium_exporter_tls_verification_disabled from the target's own config at construction time", async () => {
    const insecureTarget = { ...target("dns-a"), tlsInsecureSkipVerify: true };
    const registry = new TargetRegistry(baseConfig([insecureTarget, target("dns-b")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () => routedClient({}),
    });

    assert.equal(
      await metricValue(
        mustGet(registry, "dns-a").registry,
        "technitium_exporter_tls_verification_disabled",
      ),
      1,
    );
    assert.equal(
      await metricValue(
        mustGet(registry, "dns-b").registry,
        "technitium_exporter_tls_verification_disabled",
      ),
      0,
    );
  });

  it("increments technitium_exporter_poll_total once per cycle and records the failure reason on a rejected token", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () => routedClient({ "/api/user/session/get": INVALID_TOKEN }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();
    await entry.runCycle();

    assert.equal(await metricValue(entry.registry, "technitium_exporter_poll_total"), 2);
    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const errors =
      metrics.find((m) => m.name === "technitium_exporter_poll_errors_total")?.values ?? [];
    assert.equal(errors.find((v) => v.labels.reason === "auth")?.value, 2);
  });

  it("sets technitium_exporter_last_successful_poll_timestamp_seconds only once a cycle actually succeeds", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock,
      warn: () => {},
      createHttpClient: () =>
        routedClient({
          "/api/user/session/get": SESSION_V15_CLUSTERED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
        }),
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    assert.equal(
      await metricValue(
        entry.registry,
        "technitium_exporter_last_successful_poll_timestamp_seconds",
      ),
      clock.now() / 1000,
    );
  });

  it("wires each target's own HttpClient upstream telemetry into that target's own self-metrics", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: (_t, onUpstreamAttempt) => {
        const inner = routedClient({ "/api/user/session/get": INVALID_TOKEN });
        return {
          get: async (path: string) => {
            const response = await inner.get(path);
            onUpstreamAttempt({ path, durationMs: 12, statusCode: response.statusCode });
            return response;
          },
        };
      },
    });

    const entry = mustGet(registry, "dns-a");
    await entry.runCycle();

    const metrics = (await entry.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string> }>;
    }>;
    const requests =
      metrics.find((m) => m.name === "technitium_exporter_upstream_requests_total")?.values ?? [];
    assert.ok(
      requests.some(
        (v) => v.labels.endpoint === "/api/user/session/get" && v.labels.status_code === "200",
      ),
    );
  });

  it("startAll() actually drives real pollers, and stopAll() actually halts them", async () => {
    const clock = new FakeClock();
    let sessionCalls = 0;
    let releaseGate: (() => void) | undefined;
    let secondCallStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const secondCallStartedPromise = new Promise<void>((resolve) => {
      secondCallStarted = resolve;
    });

    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock,
      warn: () => {},
      createHttpClient: () => ({
        get: async (path: string) => {
          if (path !== "/api/user/session/get") throw new Error(`unstubbed path: ${path}`);
          sessionCalls++;
          if (sessionCalls === 2) {
            secondCallStarted?.();
            await gate;
          }
          return { statusCode: 200, body: INVALID_TOKEN };
        },
      }),
    });

    registry.startAll();
    await secondCallStartedPromise;
    assert.equal(sessionCalls, 2);

    const stopPromise = registry.stopAll();
    releaseGate?.();
    await stopPromise;

    const callsAtStop = sessionCalls;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessionCalls, callsAtStop, "no further cycle ran after stopAll() resolved");
  });

  it("single-flights concurrent renderMetrics() calls for the same target", async () => {
    const registry = new TargetRegistry(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      warn: () => {},
      createHttpClient: () => routedClient({ "/api/user/session/get": INVALID_TOKEN }),
    });

    const entry = mustGet(registry, "dns-a");
    let renderCalls = 0;
    const originalMetrics = entry.registry.metrics.bind(entry.registry);
    entry.registry.metrics = async () => {
      renderCalls++;
      return originalMetrics();
    };

    const [first, second] = await Promise.all([entry.renderMetrics(), entry.renderMetrics()]);
    assert.equal(first, second);
    assert.equal(renderCalls, 1);

    await entry.renderMetrics();
    assert.equal(renderCalls, 2);
  });
});

describe("runTargetCycle", () => {
  function fakeSuccess(permissions: Record<string, { canView: boolean }>) {
    return {
      kind: "success" as const,
      info: {
        version: "15.4",
        dnsServerDomain: "dns-a.example.com",
        clusterInitialized: false,
        clusterPeers: undefined,
        permissions,
      },
    };
  }

  function fakeSession(
    result: ReturnType<typeof fakeSuccess> | { kind: "failure"; reason: PollErrorReason },
  ) {
    const labelCalls: Array<{ collector: string }> = [];
    return {
      collect: async () => result,
      collectorSuccess: {
        labels: (labels: { collector: string }) => {
          labelCalls.push(labels);
          return { set: () => {} };
        },
      },
      labelCalls,
    };
  }

  it("skips native and zones, and zeroes their collector_success, when session fails", async () => {
    const session = fakeSession({ kind: "failure", reason: "network" });
    let nativeCalled = false;
    let zonesCalled = false;

    const result = await runTargetCycle({
      session,
      native: {
        collect: async () => {
          nativeCalled = true;
          return { kind: "success" as const };
        },
      },
      zones: {
        collect: async () => {
          zonesCalled = true;
          return { kind: "success" as const };
        },
      },
    });

    assert.equal(nativeCalled, false);
    assert.equal(zonesCalled, false);
    assert.equal(result.summary.native, "skipped");
    assert.equal(result.summary.zones, "skipped");
    assert.deepEqual(session.labelCalls.map((l) => l.collector).sort(), ["native", "zones"]);
  });

  it("skips a collector whose permission is not granted, without calling it", async () => {
    const session = fakeSession(
      fakeSuccess({ Dashboard: { canView: true }, Zones: { canView: false } }),
    );
    let zonesCalled = false;

    const result = await runTargetCycle({
      session,
      native: { collect: async () => ({ kind: "success" as const }) },
      zones: {
        collect: async () => {
          zonesCalled = true;
          return { kind: "success" as const };
        },
      },
    });

    assert.equal(zonesCalled, false);
    assert.equal(result.summary.native, "success");
    assert.equal(result.summary.zones, "skipped");
  });

  it("marks hadParseError when a granted collector fails to parse", async () => {
    const session = fakeSession(
      fakeSuccess({ Dashboard: { canView: true }, Zones: { canView: true } }),
    );

    const result = await runTargetCycle({
      session,
      native: { collect: async () => ({ kind: "failure" as const, reason: "parse" as const }) },
      zones: { collect: async () => ({ kind: "success" as const }) },
    });

    assert.equal(result.hadParseError, true);
    assert.equal(result.summary.native, "failure");
    assert.deepEqual(result.pollErrorReasons, ["parse"]);
    assert.deepEqual(result.parseErrorGroups, ["native"]);
  });

  it("collects a poll error reason for every failed collector this cycle, not just parse failures", async () => {
    const session = fakeSession(
      fakeSuccess({ Dashboard: { canView: true }, Zones: { canView: true } }),
    );

    const result = await runTargetCycle({
      session,
      native: { collect: async () => ({ kind: "failure" as const, reason: "http_5xx" as const }) },
      zones: { collect: async () => ({ kind: "failure" as const, reason: "network" as const }) },
    });

    assert.equal(result.hadParseError, false);
    assert.deepEqual([...result.pollErrorReasons].sort(), ["http_5xx", "network"]);
    assert.deepEqual(result.parseErrorGroups, []);
  });

  it("records the session's own failure reason, tagged with the session group when it's a parse failure", async () => {
    const session = fakeSession({ kind: "failure", reason: "parse" });

    const result = await runTargetCycle({
      session,
      native: { collect: async () => ({ kind: "success" as const }) },
      zones: { collect: async () => ({ kind: "success" as const }) },
    });

    assert.deepEqual(result.pollErrorReasons, ["parse"]);
    assert.deepEqual(result.parseErrorGroups, ["session"]);
  });

  it("does not count a stats/cluster failure that merely restates a prior off-cadence outcome (fresh: false)", async () => {
    const session = fakeSession(
      fakeSuccess({ Dashboard: { canView: true }, Zones: { canView: true } }),
    );

    const result = await runTargetCycle({
      session,
      native: { collect: async () => ({ kind: "success" as const }) },
      zones: { collect: async () => ({ kind: "success" as const }) },
      stats: {
        collect: async () => ({ kind: "failure" as const, reason: "parse" as const, fresh: false }),
      },
    });

    assert.equal(result.hadParseError, false);
    assert.deepEqual(result.pollErrorReasons, []);
    assert.deepEqual(result.parseErrorGroups, []);
  });
});
