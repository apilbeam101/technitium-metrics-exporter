import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Secret } from "../../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../../src/config/types.ts";
import { collectRawDump, redactRawBody, runDumpRaw } from "../../src/dump-raw.ts";
import { FakeClock } from "../support/fake-clock.ts";

const SESSION_V15 = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");
const ENVELOPE_ERROR = readFileSync("test/fixtures/session/envelope-error.json", "utf8");
const ZONES_LIST = readFileSync("test/fixtures/zones/zones-list.json", "utf8");
const NATIVE_TEXT = readFileSync("test/fixtures/native/metrics-text-current-names.txt", "utf8");

const LIVE_TOKEN = "super-secret-live-token-value";
const LIVE_STACK_TRACE = "System.Exception: boom\n   at Somewhere.DoWork()";

describe("redactRawBody", () => {
  it("redacts a top-level token field", () => {
    const body = JSON.stringify({ status: "ok", token: LIVE_TOKEN, info: { version: "15.4" } });
    const result = redactRawBody(body) as Record<string, unknown>;

    assert.equal(result.token, "[REDACTED]");
    assert.equal(JSON.stringify(result).includes(LIVE_TOKEN), false);
  });

  it("redacts a top-level stackTrace field", () => {
    const body = JSON.stringify({
      status: "error",
      errorMessage: "boom",
      stackTrace: LIVE_STACK_TRACE,
    });
    const result = redactRawBody(body) as Record<string, unknown>;

    assert.equal(result.stackTrace, "[REDACTED]");
    assert.equal(JSON.stringify(result).includes(LIVE_STACK_TRACE), false);
  });

  it("redacts the real session/get fixture's own echoed token field", () => {
    const result = redactRawBody(SESSION_V15) as Record<string, unknown>;
    assert.equal(result.token, "[REDACTED]");
  });

  it("redacts the real error envelope fixture's own stackTrace field", () => {
    const result = redactRawBody(ENVELOPE_ERROR) as Record<string, unknown>;
    assert.equal(result.stackTrace, "[REDACTED]");
  });

  it("leaves a non-JSON body (Prometheus exposition text) untouched", () => {
    assert.equal(redactRawBody(NATIVE_TEXT), NATIVE_TEXT);
  });

  it("leaves an ordinary JSON body with neither secret key structurally unchanged", () => {
    const result = redactRawBody(ZONES_LIST);
    assert.deepEqual(result, JSON.parse(ZONES_LIST));
  });

  it("passes through a JSON array or primitive body as-is", () => {
    assert.deepEqual(redactRawBody("[1,2,3]"), [1, 2, 3]);
    assert.equal(redactRawBody("42"), 42);
    assert.equal(redactRawBody("null"), null);
  });
});

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

function fakeClientHandle(
  routes: Readonly<Record<string, string | (() => Promise<never>)>>,
  onClose?: () => void,
) {
  return {
    client: {
      get: async (path: string) => {
        const body = routes[path];
        if (body === undefined) throw new Error(`unstubbed path: ${path}`);
        if (typeof body === "function") return body();
        return { statusCode: 200, body };
      },
    },
    close: async () => {
      onClose?.();
    },
  };
}

describe("collectRawDump", () => {
  it("captures every allowlisted endpoint and redacts the echoed token", async () => {
    let closed = false;
    const dump = await collectRawDump(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      createClientHandle: () =>
        fakeClientHandle(
          {
            "/api/user/session/get": SESSION_V15,
            "/api/zones/list": ZONES_LIST,
            "/api/dashboard/metrics/text": NATIVE_TEXT,
            "/api/dashboard/stats/get": JSON.stringify({ status: "ok", response: {} }),
            "/api/admin/cluster/state": JSON.stringify({ status: "ok", response: {} }),
          },
          () => {
            closed = true;
          },
        ),
    });

    const targetDump = dump["dns-a"] as Record<string, { statusCode: number; body: unknown }>;
    assert.equal(Object.keys(targetDump).length, 5);
    const sessionEntry = targetDump["/api/user/session/get"];
    assert.ok(sessionEntry);
    assert.equal(sessionEntry.statusCode, 200);
    assert.equal((sessionEntry.body as Record<string, unknown>).token, "[REDACTED]");
    assert.equal(JSON.stringify(dump).includes("REDACTED-EXAMPLE-TOKEN"), false);
    assert.equal(closed, true);
  });

  it("captures one endpoint's own failure without losing the others for that target", async () => {
    const dump = await collectRawDump(baseConfig([target("dns-a")]), {
      clock: new FakeClock(),
      createClientHandle: () =>
        fakeClientHandle({
          "/api/user/session/get": SESSION_V15,
          "/api/zones/list": () => {
            throw new Error("zones/list unreachable");
          },
          "/api/dashboard/metrics/text": NATIVE_TEXT,
          "/api/dashboard/stats/get": JSON.stringify({ status: "ok", response: {} }),
          "/api/admin/cluster/state": JSON.stringify({ status: "ok", response: {} }),
        }),
    });

    const targetDump = dump["dns-a"] as Record<string, { error?: string; statusCode?: number }>;
    assert.match(targetDump["/api/zones/list"]?.error ?? "", /unreachable/);
    assert.equal(targetDump["/api/user/session/get"]?.statusCode, 200);
  });

  it("captures one target's own construction failure without affecting another target", async () => {
    const dump = await collectRawDump(baseConfig([target("dns-a"), target("dns-b")]), {
      clock: new FakeClock(),
      createClientHandle: (t) => {
        if (t.name === "dns-a") throw new Error("dns-a: bad CA bundle path");
        return fakeClientHandle({
          "/api/user/session/get": SESSION_V15,
          "/api/zones/list": ZONES_LIST,
          "/api/dashboard/metrics/text": NATIVE_TEXT,
          "/api/dashboard/stats/get": JSON.stringify({ status: "ok", response: {} }),
          "/api/admin/cluster/state": JSON.stringify({ status: "ok", response: {} }),
        });
      },
    });

    assert.deepEqual(dump["dns-a"], { error: "dns-a: bad CA bundle path" });
    assert.equal(Object.keys(dump["dns-b"] ?? {}).length > 0, true);
  });
});

describe("runDumpRaw", () => {
  // The Phase 10 exit criterion this proves directly: --dump-raw's own
  // output, end to end through the exact function index.ts calls, cannot
  // contain a token — driven with a session/get response carrying a live-
  // looking token value rather than the fixture's already-placeholder one,
  // so this doesn't pass merely because the fixture happens to look safe.
  it("produces valid JSON whose output never contains the live upstream token", async () => {
    let written = "";
    const liveSession = JSON.stringify({
      ...JSON.parse(SESSION_V15),
      token: LIVE_TOKEN,
    });

    await runDumpRaw(
      baseConfig([target("dns-a")]),
      {
        clock: new FakeClock(),
        createClientHandle: () =>
          fakeClientHandle({
            "/api/user/session/get": liveSession,
            "/api/zones/list": ZONES_LIST,
            "/api/dashboard/metrics/text": NATIVE_TEXT,
            "/api/dashboard/stats/get": JSON.stringify({ status: "ok", response: {} }),
            "/api/admin/cluster/state": JSON.stringify({ status: "ok", response: {} }),
          }),
      },
      (text) => {
        written += text;
      },
    );

    const parsed = JSON.parse(written) as {
      targets: Record<string, Record<string, { body?: { token?: string } }>>;
    };
    assert.equal(parsed.targets["dns-a"]?.["/api/user/session/get"]?.body?.token, "[REDACTED]");
    assert.equal(written.includes(LIVE_TOKEN), false);
  });

  it("writes nothing but a trailing newline of JSON for zero configured targets", async () => {
    let written = "";
    await runDumpRaw(baseConfig([]), { clock: new FakeClock() }, (text) => {
      written += text;
    });

    const parsed = JSON.parse(written) as { targets: Record<string, unknown> };
    assert.deepEqual(parsed.targets, {});
    assert.equal(written.endsWith("\n"), true);
  });
});
