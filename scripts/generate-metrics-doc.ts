import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Registry } from "@prometheus-io/client";
import { parseClusterStateResponse } from "../src/api/cluster.ts";
import { parseNativeMetricsText } from "../src/api/native-text.ts";
import { parseSessionResponse } from "../src/api/session.ts";
import { parseStatsGetResponse } from "../src/api/stats.ts";
import { parseZonesListResponse } from "../src/api/zones.ts";
import { Secret } from "../src/config/secret.ts";
import type { AppConfig, TargetConfig } from "../src/config/types.ts";
import type { Clock } from "../src/http/clock.ts";
import { buildGlobalRegistry } from "../src/index.ts";
import { applyClusterConfigSuccess, createClusterMetrics } from "../src/metrics/cluster-metrics.ts";
import { applyNativeSuccess, createNativeMetrics } from "../src/metrics/native-metrics.ts";
import { applySessionSuccess, createSessionMetrics } from "../src/metrics/session-metrics.ts";
import { applyStatsSuccess, createStatsMetrics } from "../src/metrics/stats-metrics.ts";
import { applyZoneSuccess, createZoneMetrics } from "../src/metrics/zone-metrics.ts";
import { PollCycleTracker } from "../src/poller/cache.ts";
import { SelfMetrics } from "../src/poller/self-metrics.ts";
import type { BuildInfo } from "../src/version.ts";

const OUTPUT_PATH = "docs/METRICS.md";

// A fixed clock, not systemClock/FakeClock: this drives technitium_exporter_
// cache_age_seconds's own collect-time computation (self-metrics.ts), and a
// real wall clock would make the generated doc's example value change on
// every regeneration, which would make the drift test flap independent of
// any actual metric change.
const EXAMPLE_CLOCK: Clock = {
  now: () => 1_700_000_000_000,
  elapsed: () => 120_000,
  sleep: async () => {},
};

// Fixed rather than sourced from package.json/GIT_COMMIT (version.ts's own
// loadBuildInfo()): this is a documentation example, not a real build, and a
// real commit/version would make the committed doc go stale (or the drift
// test flap) on every unrelated release rather than only when a metric
// actually changes.
const EXAMPLE_BUILD_INFO: BuildInfo = {
  version: "0.0.0-docs-example",
  commit: "0000000",
  nodeVersion: "v24.0.0",
};

function exampleTarget(): TargetConfig {
  return {
    name: "dns-a",
    baseUrl: "https://dns-a.example.com:53443",
    apiToken: new Secret("example-token"),
    caBundlePath: undefined,
    tlsInsecureSkipVerify: false,
  };
}

function exampleAppConfig(): AppConfig {
  return {
    targets: [exampleTarget()],
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
    // Node.js default runtime metrics are excluded from the doc's global
    // section: their exact set comes from @prometheus-io/client's own
    // collectDefaultMetrics() and isn't part of this exporter's own declared
    // metric surface, so documenting them here would drift with every
    // dependency bump rather than every actual metric change.
    enableDefaultMetrics: false,
    logLevel: "info",
    logFormat: "json",
    metricsTls: undefined,
  };
}

// Builds one target-scoped Registry with every per-target collector's
// metrics wired exactly as target-registry.ts's own buildEntry() does
// (shared collectorSuccess/unknownEnum, D§4.4), then drives each one through
// its real apply*Success function against this project's own fixtures — the
// same fixtures the unit tests already exercise — so the generated doc shows
// real, representative label combinations instead of an empty label set.
function buildExampleTargetRegistry(): Registry {
  const registry = new Registry();

  const sessionMetrics = createSessionMetrics(registry);
  applySessionSuccess(
    sessionMetrics,
    parseSessionResponse(readFixture("test/fixtures/session/session-get-v15.json")),
  );

  const nativeMetrics = createNativeMetrics(registry, sessionMetrics.collectorSuccess);
  applyNativeSuccess(
    nativeMetrics,
    parseNativeMetricsText(readFixture("test/fixtures/native/metrics-text-current-names.txt")),
  );

  const zoneMetrics = createZoneMetrics(
    registry,
    sessionMetrics.collectorSuccess,
    sessionMetrics.unknownEnum,
  );
  applyZoneSuccess(
    zoneMetrics,
    parseZonesListResponse(readFixture("test/fixtures/zones/zones-list.json")),
    false,
  );

  const statsMetrics = createStatsMetrics(
    registry,
    sessionMetrics.collectorSuccess,
    sessionMetrics.unknownEnum,
    true,
  );
  applyStatsSuccess(
    statsMetrics,
    parseStatsGetResponse(readFixture("test/fixtures/stats/stats-get-full.json")),
  );

  const clusterMetrics = createClusterMetrics(registry, sessionMetrics.collectorSuccess);
  applyClusterConfigSuccess(
    clusterMetrics,
    parseClusterStateResponse(readFixture("test/fixtures/cluster/cluster-state.json")),
  );

  // Mirrors target-registry.ts's buildEntry(): pollTracker.record() first,
  // then noteCacheFetch(), so cache_age_seconds's own collect callback has a
  // real lastEntry to read.
  const pollTracker = new PollCycleTracker<{ readonly example: true }>();
  const selfMetrics = new SelfMetrics(registry, {
    clock: EXAMPLE_CLOCK,
    tlsInsecureSkipVerify: false,
    pollTracker,
  });
  selfMetrics.recordPollCycle("success", 120);
  selfMetrics.recordPollError("timeout");
  selfMetrics.recordParseError("zones");
  selfMetrics.recordUpstreamAttempt({
    path: "/api/user/session/get",
    durationMs: 45,
    statusCode: 200,
  });
  pollTracker.record({ example: true }, EXAMPLE_CLOCK.elapsed() - 5_000, false);
  selfMetrics.noteCacheFetch();

  return registry;
}

function readFixture(path: string): string {
  return readFileSync(path, "utf8");
}

async function renderMetricBlocks(registry: Registry): Promise<string[]> {
  const metrics = await registry.getMetricsAsJSON();
  const names = [...new Set(metrics.map((metric) => metric.name))].sort((a, b) =>
    a.localeCompare(b),
  );

  const blocks: string[] = [];
  for (const name of names) {
    const text = await registry.getSingleMetricAsString(name);
    blocks.push(`### \`${name}\`\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }
  return blocks;
}

export async function generateMetricsDoc(): Promise<string> {
  const targetRegistry = buildExampleTargetRegistry();
  const globalRegistry = buildGlobalRegistry(exampleAppConfig(), EXAMPLE_BUILD_INFO);

  const perTargetBlocks = await renderMetricBlocks(targetRegistry);
  const globalBlocks = await renderMetricBlocks(globalRegistry);

  const lines = [
    "# Metrics reference",
    "",
    "Generated by `scripts/generate-metrics-doc.ts` from this exporter's own live",
    "metric declarations, driven against this project's own fixtures so the",
    "examples below show real, representative label combinations rather than an",
    "empty label set. Regenerate after any metric change with:",
    "",
    "```",
    "node --experimental-strip-types scripts/generate-metrics-doc.ts",
    "```",
    "",
    "`test/unit/scripts/generate-metrics-doc.test.ts` fails if this file is out of",
    "date with the code. See [DESIGN.md §5](DESIGN.md#5-metric-surface) for what",
    "each metric means and why it exists.",
    "",
    "Node.js default runtime metrics are intentionally omitted below: their exact",
    "set comes from `@prometheus-io/client`'s own `collectDefaultMetrics()`, not",
    "from this exporter's own declared metric surface.",
    "",
    "## Per-target metrics",
    "",
    "One registry per configured target (D§4.4). Every metric below is rendered",
    "once per target, under that target's own label values, at `/metrics?target=<name>`.",
    "",
    ...perTargetBlocks,
    "## Global metrics",
    "",
    "Rendered once for the whole process, at the bare `/metrics` route (no",
    "`?target=`).",
    "",
    ...globalBlocks,
  ];

  return `${lines.join("\n")}\n`;
}

function main(): void {
  generateMetricsDoc()
    .then((doc) => {
      writeFileSync(OUTPUT_PATH, doc);
      console.log(`wrote ${OUTPUT_PATH}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
