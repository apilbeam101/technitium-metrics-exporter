import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCacheEntry, PollCycleTracker } from "../../../src/poller/cache.ts";

describe("createCacheEntry", () => {
  it("is immutable", () => {
    const entry = createCacheEntry("value", 123);
    assert.throws(() => {
      // @ts-expect-error verifying runtime immutability of a readonly type
      entry.value = "other";
    });
  });
});

describe("PollCycleTracker", () => {
  it("has not completed a cycle before record() is called", () => {
    const tracker = new PollCycleTracker<string>();
    assert.equal(tracker.hasCompletedCycle, false);
    assert.equal(tracker.completedCycles, 0);
    assert.equal(tracker.lastEntry, undefined);
  });

  it("counts both a successful and a failed cycle as completed", () => {
    const tracker = new PollCycleTracker<string>();
    tracker.record("failure", 100, false);
    assert.equal(tracker.hasCompletedCycle, true);
    assert.equal(tracker.completedCycles, 1);
    assert.equal(tracker.lastEntry?.value, "failure");
    assert.equal(tracker.lastEntry?.fetchedAt, 100);
  });

  it("tracks parse-error cycles separately from ordinary completed cycles", () => {
    const tracker = new PollCycleTracker<string>();
    tracker.record("success", 100, false);
    tracker.record("parse-failed", 200, true);

    assert.equal(tracker.completedCycles, 2);
    assert.equal(tracker.parseErrorCycles, 1);
  });
});
