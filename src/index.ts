#!/usr/bin/env node
// checkNodeVersion() only gates execution of main() below, not module
// evaluation: ESM hoists every static import in this file (including
// @prometheus-io/client, undici, and the rest of src/) above any code, so
// they are already fully evaluated regardless of where this call appears. A
// true load-time gate would need a separate entry point that checks the
// version and then dynamically await import()s everything else — not done
// here, since nothing in this codebase's own module bodies runs top-level
// code that depends on the Node version.
import { checkNodeVersion } from "./node-version-check.ts";

checkNodeVersion();

import { pathToFileURL } from "node:url";
import { collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";
import { handleCliFlags } from "./cli.ts";
import { loadEnv } from "./config/load.ts";
import { redactSummary } from "./config/redact-summary.ts";
import type { AppConfig } from "./config/types.ts";
import { ConfigError, validate } from "./config/validate.ts";
import { runDumpRaw } from "./dump-raw.ts";
import { systemClock } from "./http/clock.ts";
import { installShutdownHandlers } from "./lifecycle.ts";
import { createLogger } from "./log/logger.ts";
import { TargetRegistry } from "./poller/target-registry.ts";
import { createRequestHandler } from "./server/routes.ts";
import type { StartedServer } from "./server/server.ts";
import { startServer } from "./server/server.ts";
import type { BuildInfo } from "./version.ts";
import { loadBuildInfo } from "./version.ts";

export function buildGlobalRegistry(config: AppConfig, buildInfo: BuildInfo): Registry {
  const registry = new Registry();

  if (config.enableDefaultMetrics) collectDefaultMetrics({ register: registry });

  new Gauge({
    name: "technitium_exporter_build_info",
    help: "Exporter build information; always 1",
    labelNames: ["version", "commit", "node_version"],
    registers: [registry],
  })
    .labels({
      version: buildInfo.version,
      commit: buildInfo.commit,
      node_version: buildInfo.nodeVersion,
    })
    .set(1);

  new Gauge({
    name: "technitium_exporter_targets",
    help: "Number of configured targets",
    registers: [registry],
  }).set(config.targets.length);

  return registry;
}

// A construction failure after the listener is already up (e.g. TargetRegistry
// throwing because a target's caBundlePath doesn't exist) must not leave a
// permanent zombie: the open listener alone keeps the event loop alive
// forever, and /readyz would stay 503 forever while /healthz keeps lying
// that everything is fine. build() runs after listen() has already
// succeeded, so any throw from it closes the server before propagating,
// rather than leaving it open with no owner.
export async function afterListen<T>(
  started: StartedServer,
  build: () => T | Promise<T>,
): Promise<T> {
  try {
    return await build();
  } catch (error) {
    await started.close();
    throw error;
  }
}

async function main(): Promise<void> {
  if (handleCliFlags(process.argv.slice(2), (text) => process.stdout.write(text))) return;

  let env: Record<string, string | undefined>;
  try {
    env = loadEnv(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  let config: AppConfig;
  let warnings: readonly string[];
  try {
    ({ config, warnings } = validate(env));
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error:\n${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // --dump-raw needs the fully loaded/validated AppConfig (targets, tokens,
  // CA bundles) to do anything, unlike --version/--help, so it's checked
  // here rather than in cli.ts's handleCliFlags — and it never starts the
  // server or poller at all, unlike every other startup path below.
  // allLogsToStderr reserves stdout for the sanitised dump itself.
  if (process.argv.includes("--dump-raw")) {
    const logger = createLogger({
      level: config.logLevel,
      format: config.logFormat,
      allLogsToStderr: true,
    });
    for (const warning of warnings) logger.warn(warning);
    logger.info("configuration loaded", redactSummary(config));
    await runDumpRaw(config, { clock: systemClock }, (text) => process.stdout.write(text));
    return;
  }

  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  for (const warning of warnings) logger.warn(warning);
  logger.info("configuration loaded", redactSummary(config));

  const buildInfo = loadBuildInfo();
  logger.info("build info", { ...buildInfo });

  const globalRegistry = buildGlobalRegistry(config, buildInfo);

  // The listener starts before the TargetRegistry even exists (D§7 startup
  // order: listen at step 5, poller construct at step 6), so /healthz can
  // answer immediately and a slow or absent target never delays it. Routes
  // consult targetRegistry through this mutable holder rather than a value
  // captured at handler-construction time.
  let targetRegistry: TargetRegistry | undefined;
  const handler = createRequestHandler({
    globalRegistry,
    getTargetRegistry: () => targetRegistry,
    logger,
  });

  const started = await startServer(config, handler, logger);
  logger.info(`listening on ${config.metricsBindAddress}:${config.metricsPort}`);

  // Anything build() throws (e.g. TargetRegistry's constructor, via a
  // target's caBundlePath pointing at a missing file) runs after listen()
  // has already succeeded, so afterListen() closes the just-opened server
  // before this rethrows into the catch below — otherwise the open listener
  // alone would keep the process alive forever with no working target ever
  // assigned to targetRegistry.
  targetRegistry = await afterListen(started, () => {
    const registry = new TargetRegistry(config, {
      clock: systemClock,
      warn: (targetName, message) => logger.warn(message, { target: targetName }),
    });

    installShutdownHandlers({
      targetRegistry: registry,
      closeServer: started.close,
      logger,
    });

    // Each target's own SessionCollector.collect() first call is its
    // preflight; TargetPoller's own per-target startup jitter is what already
    // staggers it, so it isn't separately awaited here — awaiting it would
    // either defeat that jitter (by forcing every target's first call to
    // fire before this function can return) or block main() on however long
    // the slowest target takes to answer, neither of which is required now
    // that the listener and signal handlers are already both live.
    registry.startAll();

    return registry;
  });
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
