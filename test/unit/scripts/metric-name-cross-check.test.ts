import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Secret } from "../../../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../../../src/config/types.ts";
import { buildGlobalRegistry } from "../../../src/index.ts";
import { TargetRegistry } from "../../../src/poller/target-registry.ts";
import { FakeClock } from "../../support/fake-clock.ts";

const ALERTS_RULES = readFileSync("alerts/technitium-dns.yaml", "utf8");
const ALERTS_TESTS = readFileSync("alerts/technitium-dns.test.yaml", "utf8");
const DASHBOARD = readFileSync("dashboards/technitium-dns.json", "utf8");

const SESSION_ADMIN_GRANTED = (() => {
  const raw = JSON.parse(readFileSync("test/fixtures/session/session-get-v15.json", "utf8")) as {
    info: { permissions: Record<string, { canView: boolean }> };
  };
  raw.info.permissions.Administration = { canView: true };
  return JSON.stringify(raw);
})();

const NATIVE_CURRENT = readFileSync("test/fixtures/native/metrics-text-current-names.txt", "utf8");
const ZONES_LIST = readFileSync("test/fixtures/zones/zones-list.json", "utf8");
const STATS_FULL = readFileSync("test/fixtures/stats/stats-get-full.json", "utf8");
const CLUSTER_STATE = readFileSync("test/fixtures/cluster/cluster-state.json", "utf8");

function fullyEnabledTarget(): TargetConfig {
  return {
    name: "dns-a",
    baseUrl: "https://dns-a.example.com",
    apiToken: new Secret("token"),
    caBundlePath: undefined,
    tlsInsecureSkipVerify: false,
  };
}

function fullyEnabledAppConfig(): AppConfig {
  return {
    targets: [fullyEnabledTarget()],
    metricsPort: 10053,
    metricsBindAddress: "0.0.0.0",
    pollIntervalSeconds: 30,
    clusterPollIntervalSeconds: 60,
    statsPollIntervalSeconds: 300,
    requestTimeoutSeconds: 15,
    enableClusterCollector: true,
    enableStatsCollector: true,
    enableStatsQueryTypes: true,
    zonesIncludeInternal: false,
    enableDefaultMetrics: false,
    logLevel: "info",
    logFormat: "json",
    metricsTls: undefined,
  };
}

async function declaredMetricTypes(): Promise<Map<string, string>> {
  const registry = new TargetRegistry(fullyEnabledAppConfig(), {
    clock: new FakeClock(),
    warn: () => {},
    createHttpClient: () => ({
      get: async (path: string) => {
        const routes: Record<string, string> = {
          "/api/user/session/get": SESSION_ADMIN_GRANTED,
          "/api/dashboard/metrics/text": NATIVE_CURRENT,
          "/api/zones/list": ZONES_LIST,
          "/api/dashboard/stats/get": STATS_FULL,
          "/api/admin/cluster/state": CLUSTER_STATE,
        };
        const body = routes[path];
        if (body === undefined) throw new Error(`unstubbed path: ${path}`);
        return { statusCode: 200, body };
      },
    }),
  });

  const maybeEntry = registry.get("dns-a");
  assert.notEqual(maybeEntry, undefined);
  const entry = maybeEntry as NonNullable<typeof maybeEntry>;
  await entry.runCycle();

  const perTarget = (await entry.registry.getMetricsAsJSON()) as Array<{
    name: string;
    type: string;
  }>;

  const globalRegistry = buildGlobalRegistry(fullyEnabledAppConfig(), {
    version: "0.0.0-test",
    commit: "0000000",
    nodeVersion: "v24.0.0",
  });
  const global = (await globalRegistry.getMetricsAsJSON()) as Array<{ name: string; type: string }>;

  return new Map([...perTarget, ...global].map((m) => [m.name, m.type]));
}

// A histogram registers under its base name; _bucket/_sum/_count are
// PromQL-visible suffixes, not separate declarations, so a reference to one
// of those forms is checked against the base name instead — but only when
// that base name is actually a histogram, so an undeclared
// "technitium_zones_visible_count" can't pass by having its suffix stripped
// down to an unrelated, real gauge name.
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"];

function isDeclared(name: string, declared: Map<string, string>): boolean {
  if (declared.has(name)) return true;
  const suffix = HISTOGRAM_SUFFIXES.find((s) => name.endsWith(s));
  if (suffix === undefined) return false;
  const base = name.slice(0, -suffix.length);
  return declared.get(base) === "histogram";
}

// Every technitium_-prefixed token referenced by an alert expression,
// annotation, or dashboard panel — not just the ones this test's author
// remembered to list — so a rename that updates the source but not these
// generated/hand-written artefacts is caught here rather than at query time
// against a series that no longer exists (D§7). Case-insensitive so a
// mis-cased reference (technitium_Zones_visible) is still extracted and then
// correctly fails the declared-name check, rather than not matching at all.
// The trailing (:[a-zA-Z0-9_]+)? captures a recording-rule-style suffix
// (technitium_up:rate5m) so it isn't silently truncated to the valid-looking
// "technitium_up" and waved through.
function referencedMetricNames(text: string): Set<string> {
  return new Set(text.match(/technitium_[a-zA-Z0-9_]+(?::[a-zA-Z0-9_]+)?/g) ?? []);
}

describe("dashboard and alert metric-name cross-check", () => {
  it("references only metric names this exporter's own registries actually render", async () => {
    const declared = await declaredMetricTypes();
    assert.ok(declared.size > 0);

    for (const [label, text] of [
      ["alerts/technitium-dns.yaml", ALERTS_RULES],
      ["alerts/technitium-dns.test.yaml", ALERTS_TESTS],
      ["dashboards/technitium-dns.json", DASHBOARD],
    ] as const) {
      const names = referencedMetricNames(text);
      assert.ok(names.size > 0, `${label}: extraction found no technitium_ references at all`);

      for (const name of names) {
        assert.ok(
          !name.includes(":"),
          `${label} references an unsupported recording-rule form: ${name}`,
        );
        assert.ok(isDeclared(name, declared), `${label} references undeclared metric: ${name}`);
      }
    }
  });
});
