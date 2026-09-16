import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Secret } from "../../../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../../../src/config/types.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
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

function target(name: string): TargetConfig {
  return {
    name,
    baseUrl: `https://${name}.example.com`,
    apiToken: new Secret("token"),
    caBundlePath: undefined,
    tlsInsecureSkipVerify: false,
  };
}

function baseConfig(targets: readonly TargetConfig[]): AppConfig {
  return {
    targets,
    metricsPort: 10053,
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
    result: ReturnType<typeof fakeSuccess> | { kind: "failure"; reason: "network" },
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
  });
});
