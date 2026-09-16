import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemClock } from "../../../src/http/clock.ts";

describe("systemClock", () => {
  it("now() returns a wall-clock epoch millisecond value", () => {
    const before = Date.now();
    const value = systemClock.now();
    const after = Date.now();
    assert.ok(value >= before && value <= after);
  });

  it("elapsed() is monotonic across a real sleep", async () => {
    const start = systemClock.elapsed();
    await systemClock.sleep(5);
    const end = systemClock.elapsed();
    assert.ok(end > start);
  });

  it("sleep() resolves after roughly the requested duration", async () => {
    const start = systemClock.elapsed();
    await systemClock.sleep(10);
    const end = systemClock.elapsed();
    assert.ok(end - start >= 9);
  });

  it("sleep() resolves early when its signal is aborted, well before the requested duration", async () => {
    const controller = new AbortController();
    const start = systemClock.elapsed();
    const promise = systemClock.sleep(60_000, controller.signal);
    controller.abort();
    await promise;
    assert.ok(systemClock.elapsed() - start < 1_000);
  });

  it("sleep() resolves immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = systemClock.elapsed();
    await systemClock.sleep(60_000, controller.signal);
    assert.ok(systemClock.elapsed() - start < 1_000);
  });

  it("sleep() clears its underlying timer on abort rather than leaving it live", async () => {
    const controller = new AbortController();
    let clearedHandle: unknown;
    const originalClearTimeout = global.clearTimeout;
    global.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      clearedHandle = handle;
      return originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      const promise = systemClock.sleep(60_000, controller.signal);
      controller.abort();
      await promise;
    } finally {
      global.clearTimeout = originalClearTimeout;
    }

    assert.notEqual(clearedHandle, undefined);
  });
});
