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
});
