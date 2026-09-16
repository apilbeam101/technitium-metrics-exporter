import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSignalHandler, shutdown } from "../../src/lifecycle.ts";
import { createLogger } from "../../src/log/logger.ts";

function silentLogger() {
  return createLogger({ level: "error", format: "text" });
}

describe("shutdown", () => {
  it("stops the poller and closes the server, in that order", async () => {
    const calls: string[] = [];
    await shutdown({
      targetRegistry: {
        stopAll: async () => {
          calls.push("stopAll");
        },
      },
      closeServer: async () => {
        calls.push("closeServer");
      },
      logger: silentLogger(),
    });

    assert.deepEqual(calls, ["stopAll", "closeServer"]);
  });
});

describe("createSignalHandler", () => {
  it("runs the shutdown sequence and exits 0 on success", async () => {
    let stopped = false;
    let closed = false;
    let exitCode: number | undefined;

    const handler = createSignalHandler(
      {
        targetRegistry: {
          stopAll: async () => {
            stopped = true;
          },
        },
        closeServer: async () => {
          closed = true;
        },
        logger: silentLogger(),
      },
      (code) => {
        exitCode = code;
      },
    );

    handler("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stopped, true);
    assert.equal(closed, true);
    assert.equal(exitCode, 0);
  });

  it("exits 1 if the shutdown sequence itself throws", async () => {
    let exitCode: number | undefined;

    const handler = createSignalHandler(
      {
        targetRegistry: {
          stopAll: async () => {
            throw new Error("stuck poller");
          },
        },
        closeServer: async () => {},
        logger: silentLogger(),
      },
      (code) => {
        exitCode = code;
      },
    );

    handler("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(exitCode, 1);
  });

  it("is idempotent across repeated signals", async () => {
    let stopCalls = 0;
    let exitCalls = 0;

    const handler = createSignalHandler(
      {
        targetRegistry: {
          stopAll: async () => {
            stopCalls++;
          },
        },
        closeServer: async () => {},
        logger: silentLogger(),
      },
      () => {
        exitCalls++;
      },
    );

    handler("SIGTERM");
    handler("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stopCalls, 1);
    assert.equal(exitCalls, 1);
  });
});
