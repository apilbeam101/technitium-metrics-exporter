import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Clock } from "../../../src/http/clock.ts";
import { TargetPoller } from "../../../src/poller/target-poller.ts";

// A clock whose sleep() only resolves once the test explicitly releases it,
// unlike FakeClock's sleep() (which resolves immediately without waiting in
// real time). TargetPoller's loop is driven entirely by clock.sleep(), so
// this is what lets a test step through the loop one iteration at a time
// instead of racing through it at microtask speed.
class ManualClock implements Clock {
  #nowMs = 0;
  #pending: Array<{ readonly ms: number; readonly resolve: () => void }> = [];

  now(): number {
    return this.#nowMs;
  }

  elapsed(): number {
    return this.#nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const entry = { ms, resolve };
      this.#pending.push(entry);
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.#pending.indexOf(entry);
          if (index !== -1) this.#pending.splice(index, 1);
          resolve();
        },
        { once: true },
      );
    });
  }

  get pendingSleepCount(): number {
    return this.#pending.length;
  }

  get pendingSleepDurations(): readonly number[] {
    return this.#pending.map((p) => p.ms);
  }

  // Resolves the oldest pending sleep() call and lets its continuation run.
  // setImmediate (a macrotask), not a fixed number of chained microtasks, is
  // what reliably drains every microtask hop between resolve() and the
  // loop's next synchronous section (Promise.race adds its own internal
  // .then hops on top of #sleep's and #loop's own awaits).
  async releaseOne(): Promise<void> {
    const next = this.#pending.shift();
    assert.ok(next !== undefined, "releaseOne() called with no pending sleep");
    this.#nowMs += next.ms;
    next.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("TargetPoller", () => {
  it("sleeps a bounded jitter delay before the very first cycle", async () => {
    const clock = new ManualClock();
    let cycles = 0;
    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 30_000,
      runCycle: async () => {
        cycles++;
      },
      jitter: () => 12_345,
    });

    poller.start();
    await Promise.resolve();

    assert.deepEqual(clock.pendingSleepDurations, [12_345]);
    assert.equal(cycles, 0);

    await clock.releaseOne();
    assert.equal(cycles, 1);

    await poller.stop();
  });

  it("never starts a new cycle before the previous one has finished", async () => {
    const clock = new ManualClock();
    let running = 0;
    let maxConcurrent = 0;
    let resolveCycle: (() => void) | undefined;

    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 1000,
      jitter: () => 0,
      runCycle: () =>
        new Promise<void>((resolve) => {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          resolveCycle = () => {
            running--;
            resolve();
          };
        }),
    });

    poller.start();
    await clock.releaseOne(); // jitter sleep resolves, first cycle starts

    assert.equal(running, 1);
    resolveCycle?.();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(maxConcurrent, 1);
    await poller.stop();
  });

  it("sleeps the full poll interval between cycles", async () => {
    const clock = new ManualClock();
    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 5000,
      jitter: () => 0,
      runCycle: async () => {},
    });

    poller.start();
    await clock.releaseOne(); // jitter
    await poller.waitForCycle(1);

    assert.deepEqual(clock.pendingSleepDurations, [5000]);
    await poller.stop();
  });

  it("stop() completes without waiting out an in-flight interval sleep", async () => {
    const clock = new ManualClock();
    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 60_000,
      jitter: () => 0,
      runCycle: async () => {},
    });

    poller.start();
    await clock.releaseOne(); // jitter
    await poller.waitForCycle(1);

    const stopped = poller.stop();
    await assert.doesNotReject(stopped);
  });

  it("stop() lets an in-flight cycle finish before halting", async () => {
    const clock = new ManualClock();
    let cycleFinished = false;
    let resolveCycle: (() => void) | undefined;

    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 1000,
      jitter: () => 0,
      runCycle: () =>
        new Promise<void>((resolve) => {
          resolveCycle = () => {
            cycleFinished = true;
            resolve();
          };
        }),
    });

    poller.start();
    await clock.releaseOne(); // jitter resolves, cycle starts and is now in flight

    const stopPromise = poller.stop();
    assert.equal(cycleFinished, false);

    resolveCycle?.();
    await stopPromise;
    assert.equal(cycleFinished, true);
  });

  it("does not run any cycle after stop()", async () => {
    const clock = new ManualClock();
    let cycles = 0;

    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 1000,
      jitter: () => 0,
      runCycle: async () => {
        cycles++;
      },
    });

    poller.start();
    await clock.releaseOne(); // jitter
    await poller.waitForCycle(1);
    assert.equal(cycles, 1);

    assert.equal(clock.pendingSleepCount, 1);
    await poller.stop();
    assert.equal(cycles, 1);

    // stop() aborts the in-flight interval sleep rather than merely racing
    // and abandoning it — the abandoned sleep's own timer would otherwise
    // stay live for the rest of the poll interval (see clock.ts's sleep()
    // and target-poller.ts's stop()).
    assert.equal(clock.pendingSleepCount, 0);
  });

  it("bounds the default jitter delay to a small fixed ceiling regardless of pollIntervalMs", async () => {
    const clock = new ManualClock();
    const poller = new TargetPoller({
      clock,
      pollIntervalMs: 86_400_000, // the legal max, POLL_INTERVAL_SECONDS=86400
      runCycle: async () => {},
    });

    poller.start();
    await Promise.resolve();

    assert.equal(clock.pendingSleepCount, 1);
    const [jitterMs] = clock.pendingSleepDurations;
    assert.ok(
      jitterMs !== undefined && jitterMs <= 5_000,
      `expected jitter <= 5000ms, got ${jitterMs}`,
    );

    await poller.stop();
  });
});
