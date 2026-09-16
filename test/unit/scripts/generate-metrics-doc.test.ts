import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateMetricsDoc } from "../../../scripts/generate-metrics-doc.ts";
import { Secret } from "../../../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../../../src/config/types.ts";
import { TargetRegistry } from "../../../src/poller/target-registry.ts";
import { FakeClock } from "../../support/fake-clock.ts";

const COMMITTED_DOC = readFileSync("docs/METRICS.md", "utf8");

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

describe("generate-metrics-doc", () => {
  // The Phase 10 exit criterion: docs/METRICS.md must be byte-for-byte what
  // the generator produces right now, so a metric change that isn't
  // accompanied by regenerating the doc (node --experimental-strip-types
  // scripts/generate-metrics-doc.ts) fails this test instead of drifting
  // silently.
  it("matches the committed docs/METRICS.md byte-for-byte", async () => {
    const generated = await generateMetricsDoc();
    assert.equal(generated, COMMITTED_DOC);
  });

  it("documents every metric this project's own metrics modules declare, by name", async () => {
    const generated = await generateMetricsDoc();

    const expectedNames = [
      "technitium_up",
      "technitium_permission_granted",
      "technitium_cluster_initialized",
      "technitium_collector_success",
      "technitium_cluster_node_state",
      "technitium_cluster_node_last_seen_timestamp_seconds",
      "technitium_cluster_nodes",
      "technitium_exporter_unknown_enum_total",
      "technitium_server_version_info",
      "technitium_server_version_supported",
      "technitium_server_domain_info",
      "technitium_queries_total",
      "technitium_lifetime_counters_supported",
      "technitium_exporter_unknown_native_metric_total",
      "technitium_zone_soa_serial",
      "technitium_zones_visible",
      "technitium_zones_by_type",
      "technitium_zones_excluded_internal",
      "technitium_stats_window_queries",
      "technitium_stats_window_seconds",
      "technitium_zones_reported",
      "technitium_cluster_heartbeat_refresh_interval_seconds",
      "technitium_cluster_config_last_synced_timestamp_seconds",
      "technitium_exporter_last_successful_poll_timestamp_seconds",
      "technitium_exporter_cache_age_seconds",
      "technitium_exporter_poll_total",
      "technitium_exporter_poll_errors_total",
      "technitium_exporter_poll_duration_seconds",
      "technitium_exporter_upstream_requests_total",
      "technitium_exporter_upstream_request_duration_seconds",
      "technitium_exporter_parse_errors_total",
      "technitium_exporter_series",
      "technitium_exporter_tls_verification_disabled",
      "technitium_exporter_build_info",
      "technitium_exporter_targets",
    ];

    for (const name of expectedNames) {
      assert.match(generated, new RegExp(`### \`${name}\`\\n`), `missing metric: ${name}`);
    }
  });

  // The two tests above only ever check the generator's own output against
  // itself (a hand-maintained expectedNames list, or the committed doc the
  // generator itself produced) — neither one notices a metrics module that
  // gets wired into a real target's registry (target-registry.ts's own
  // buildEntry) without a matching entry in this generator's own hand-built
  // buildExampleTargetRegistry(). This test closes that gap by driving an
  // actual TargetRegistry, with every optional collector turned on and every
  // permission granted, through one real poll cycle, then asserting the
  // generator documents every series that registry actually renders — so a
  // future collector wired into buildEntry but forgotten here fails this
  // test rather than leaving docs/METRICS.md silently incomplete.
  it("documents every metric a fully-wired real TargetRegistry actually renders for a target", async () => {
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

    const renderedNames = new Set(
      ((await entry.registry.getMetricsAsJSON()) as Array<{ name: string }>).map((m) => m.name),
    );
    assert.ok(renderedNames.size > 0);

    const generated = await generateMetricsDoc();
    for (const name of renderedNames) {
      assert.match(
        generated,
        new RegExp(`### \`${name}\`\\n`),
        `generator does not document real, rendered metric: ${name}`,
      );
    }
  });
});
