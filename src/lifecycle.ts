import type { Logger } from "./log/logger.ts";
import type { TargetRegistry } from "./poller/target-registry.ts";

export interface ShutdownDeps {
  readonly targetRegistry: Pick<TargetRegistry, "stopAll">;
  readonly closeServer: () => Promise<void>;
  readonly logger: Logger;
}

// Stops every target's poller (letting any in-flight cycle finish rather
// than aborting it — see target-poller.ts's stop()) before closing the
// listener, so in-flight scrapes get to finish and no poller is left
// running against a registry a render might still be reading from.
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  deps.logger.info("shutting down");
  await deps.targetRegistry.stopAll();
  await deps.closeServer();
  deps.logger.info("shutdown complete");
}

// Split out from installShutdownHandlers so a test can drive the handler
// directly with a stub exit function, instead of sending a real signal to
// the test process itself or mocking process.exit globally.
export function createSignalHandler(
  deps: ShutdownDeps,
  exit: (code: number) => void,
): (signal: string) => void {
  let shuttingDown = false;

  return (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    deps.logger.info(`received ${signal}, shutting down`);
    shutdown(deps)
      .then(() => exit(0))
      .catch((error: unknown) => {
        deps.logger.error(
          `shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        exit(1);
      });
  };
}

export function installShutdownHandlers(
  deps: ShutdownDeps,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const handler = createSignalHandler(deps, exit);
  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT", () => handler("SIGINT"));
}
