import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { Secret } from "../../../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../../../src/config/types.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { createLogger } from "../../../src/log/logger.ts";
import { TargetRegistry } from "../../../src/poller/target-registry.ts";
import { createRequestHandler } from "../../../src/server/routes.ts";
import { SERVER_HARDENING, startServer } from "../../../src/server/server.ts";
import { FakeClock } from "../../support/fake-clock.ts";

const SESSION_V15_CLUSTERED = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");
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

function baseConfig(targets: readonly TargetConfig[], port: number): AppConfig {
  return {
    targets,
    metricsPort: port,
    metricsBindAddress: "127.0.0.1",
    pollIntervalSeconds: 30,
    clusterPollIntervalSeconds: 60,
    statsPollIntervalSeconds: 300,
    requestTimeoutSeconds: 15,
    enableClusterCollector: false,
    enableStatsCollector: false,
    enableStatsQueryTypes: false,
    zonesIncludeInternal: false,
    enableDefaultMetrics: false,
    logLevel: "error",
    logFormat: "text",
    metricsTls: undefined,
  };
}

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

async function withServer(
  targets: readonly TargetConfig[],
  createHttpClient: (t: TargetConfig) => ReturnType<typeof routedClient>,
  run: (baseUrl: string, targetRegistry: TargetRegistry, globalRegistry: Registry) => Promise<void>,
): Promise<void> {
  const config = baseConfig(targets, 0);
  const globalRegistry = new Registry();
  const targetRegistry = new TargetRegistry(config, {
    clock: new FakeClock(),
    warn: () => {},
    createHttpClient,
  });

  const logger = createLogger({ level: "error", format: "text" });
  const handler = createRequestHandler({
    globalRegistry,
    getTargetRegistry: () => targetRegistry,
    logger,
  });
  const started = await startServer(config, handler, logger);

  const address = started.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl, targetRegistry, globalRegistry);
  } finally {
    await started.close();
  }
}

describe("metrics server", () => {
  it("applies the hardening snapshot to the underlying http.Server", async () => {
    const config = baseConfig([], 0);
    const logger = createLogger({ level: "error", format: "text" });
    const started = await startServer(
      config,
      createRequestHandler({
        globalRegistry: new Registry(),
        getTargetRegistry: () => undefined,
        logger,
      }),
      logger,
    );

    try {
      assert.equal(started.server.headersTimeout, SERVER_HARDENING.headersTimeoutMs);
      assert.equal(started.server.requestTimeout, SERVER_HARDENING.requestTimeoutMs);
      assert.equal(started.server.keepAliveTimeout, SERVER_HARDENING.keepAliveTimeoutMs);
      assert.equal(started.server.maxConnections, SERVER_HARDENING.maxConnections);
    } finally {
      await started.close();
    }
  });

  it("bare /metrics returns only global series, never per-target data", async () => {
    await withServer(
      [target("dns-a")],
      () => routedClient({ "/api/user/session/get": SESSION_V15_CLUSTERED }),
      async (baseUrl, targetRegistry) => {
        await targetRegistry.get("dns-a")?.runCycle();

        const res = await fetch(`${baseUrl}/metrics`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(!body.includes("technitium_up"));
      },
    );
  });

  it("renders a specific target's own series via ?target=", async () => {
    await withServer(
      [target("dns-a")],
      () =>
        routedClient({
          "/api/user/session/get": SESSION_V15_CLUSTERED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
        }),
      async (baseUrl, targetRegistry) => {
        await targetRegistry.get("dns-a")?.runCycle();

        const res = await fetch(`${baseUrl}/metrics?target=dns-a`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.match(body, /technitium_up 1/);
      },
    );
  });

  it("returns 400 for an unknown ?target= value", async () => {
    await withServer(
      [target("dns-a")],
      () => routedClient({}),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/metrics?target=nope`);
        assert.equal(res.status, 400);
      },
    );
  });

  it("returns 404 for an unknown route", async () => {
    await withServer(
      [],
      () => routedClient({}),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/nonexistent`);
        assert.equal(res.status, 404);
      },
    );
  });

  it("returns 405 with an Allow header for a wrong method on a known route", async () => {
    await withServer(
      [],
      () => routedClient({}),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/metrics`, { method: "POST" });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), "GET");
      },
    );
  });

  it("/healthz answers 200 immediately regardless of poll outcomes", async () => {
    await withServer(
      [target("dns-a")],
      () => routedClient({}),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/healthz`);
        assert.equal(res.status, 200);
      },
    );
  });

  it("/readyz is 503 before every target has completed a cycle, 200 after", async () => {
    await withServer(
      [target("dns-a")],
      () => routedClient({ "/api/user/session/get": SESSION_V15_CLUSTERED }),
      async (baseUrl, targetRegistry) => {
        const before = await fetch(`${baseUrl}/readyz`);
        assert.equal(before.status, 503);

        await targetRegistry.get("dns-a")?.runCycle();

        const after = await fetch(`${baseUrl}/readyz`);
        assert.equal(after.status, 200);
      },
    );
  });

  it("keeps one target's render independent of another target's slow render", async () => {
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    await withServer(
      [target("dns-a"), target("dns-b")],
      (t) =>
        t.name === "dns-a"
          ? routedClient({ "/api/user/session/get": SESSION_V15_CLUSTERED })
          : {
              get: async () => {
                await slowGate;
                return { statusCode: 200, body: SESSION_V15_CLUSTERED };
              },
            },
      async (baseUrl, targetRegistry) => {
        await targetRegistry.get("dns-a")?.runCycle();
        const slowCycle = targetRegistry.get("dns-b")?.runCycle();

        const res = await fetch(`${baseUrl}/metrics?target=dns-a`);
        assert.equal(res.status, 200);

        releaseSlow?.();
        await slowCycle;
      },
    );
  });

  it("serves one target's scrape fast while a concurrent scrape of a different target is slow", async () => {
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    await withServer(
      [target("dns-a"), target("dns-b")],
      () => routedClient({ "/api/user/session/get": SESSION_V15_CLUSTERED }),
      async (baseUrl, targetRegistry) => {
        await Promise.all([
          targetRegistry.get("dns-a")?.runCycle(),
          targetRegistry.get("dns-b")?.runCycle(),
        ]);

        const entryB = targetRegistry.get("dns-b");
        if (entryB === undefined) throw new Error("expected dns-b to exist");
        const originalMetrics = entryB.registry.metrics.bind(entryB.registry);
        entryB.registry.metrics = async () => {
          await slowGate;
          return originalMetrics();
        };

        const fastRequest = fetch(`${baseUrl}/metrics?target=dns-a`);
        const slowRequest = fetch(`${baseUrl}/metrics?target=dns-b`);

        const fastStart = Date.now();
        const fast = await fastRequest;
        const fastElapsedMs = Date.now() - fastStart;

        assert.equal(fast.status, 200);
        assert.match(await fast.text(), /technitium_up 1/);
        // Generous relative to the deliberately-unbounded slowGate below:
        // this only needs to prove dns-a's response didn't wait on dns-b's
        // render, not pin down an exact latency.
        assert.ok(
          fastElapsedMs < 1_000,
          `expected dns-a's response to return promptly, took ${fastElapsedMs}ms`,
        );

        releaseSlow?.();
        const slow = await slowRequest;
        assert.equal(slow.status, 200);
      },
    );
  });

  it("leaves one target's up=1 intact when another target is hard down (N3)", async () => {
    await withServer(
      [target("dns-a"), target("dns-b")],
      (t) =>
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
      async (baseUrl, targetRegistry) => {
        await Promise.all([
          targetRegistry.get("dns-a")?.runCycle(),
          targetRegistry.get("dns-b")?.runCycle(),
        ]);

        const a = await fetch(`${baseUrl}/metrics?target=dns-a`);
        const b = await fetch(`${baseUrl}/metrics?target=dns-b`);

        assert.match(await a.text(), /technitium_up 1/);
        assert.match(await b.text(), /technitium_up 0/);
      },
    );
  });

  it("single-flights concurrent scrapes of the same target", async () => {
    await withServer(
      [target("dns-a")],
      () => routedClient({ "/api/user/session/get": SESSION_V15_CLUSTERED }),
      async (baseUrl, targetRegistry) => {
        await targetRegistry.get("dns-a")?.runCycle();

        const entry = targetRegistry.get("dns-a");
        if (entry === undefined) throw new Error("expected dns-a to exist");
        let renderCalls = 0;
        const original = entry.registry.metrics.bind(entry.registry);
        // Widened with a real delay: two genuinely separate HTTP connections
        // racing over the network won't land in the same microtask tick the
        // way two direct in-process calls would, so an instant render risks
        // the first request finishing before the second one is even
        // dispatched — this is what actually proves the second concurrent
        // request found a render already in flight, rather than starting
        // its own.
        entry.registry.metrics = async () => {
          renderCalls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return original();
        };

        const [a, b] = await Promise.all([
          fetch(`${baseUrl}/metrics?target=dns-a`),
          fetch(`${baseUrl}/metrics?target=dns-a`),
        ]);

        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(renderCalls, 1);
      },
    );
  });
});
