import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withBudgetedRetry } from "../../../src/http/retry.ts";
import { FakeClock } from "../../support/fake-clock.ts";

class RetryableError extends Error {}
class FatalError extends Error {}

describe("withBudgetedRetry", () => {
  it("returns the result on first success without sleeping", async () => {
    const clock = new FakeClock();
    const result = await withBudgetedRetry(
      { clock, budgetMs: 1000, isRetryable: () => true },
      async () => "ok",
    );
    assert.equal(result, "ok");
    assert.equal(clock.elapsed(), 0);
  });

  it("retries a retryable failure and eventually succeeds", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const result = await withBudgetedRetry(
      { clock, budgetMs: 5000, isRetryable: (error) => error instanceof RetryableError },
      async () => {
        attempts++;
        if (attempts < 3) throw new RetryableError("not yet");
        return "ok";
      },
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("does not retry a non-retryable error", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    await assert.rejects(
      withBudgetedRetry(
        { clock, budgetMs: 5000, isRetryable: (error) => error instanceof RetryableError },
        async () => {
          attempts++;
          throw new FatalError("nope");
        },
      ),
      FatalError,
    );
    assert.equal(attempts, 1);
  });

  it("gives up immediately rather than sleeping away the whole budget on a doomed final attempt", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    await assert.rejects(
      withBudgetedRetry(
        { clock, budgetMs: 100, baseDelayMs: 200, isRetryable: () => true },
        async () => {
          attempts++;
          throw new RetryableError(`attempt ${attempts}`);
        },
      ),
      (error: unknown) => error instanceof RetryableError && error.message === "attempt 1",
    );
    // The 200ms base backoff would consume more than the 100ms of budget
    // left after attempt 1, leaving nothing real for a second attempt to run
    // with — so it throws attempt 1's own error immediately instead of
    // sleeping through the whole remaining budget for a doomed retry.
    assert.equal(attempts, 1);
  });

  it("gives up on a retry that would leave only a sliver of budget, even though that sliver is positive", async () => {
    // A bare ">0" check on the budget remaining after backoff (rather than
    // a real floor) lets a retry through with almost nothing left for the
    // attempt that follows — which then times out before a fast server can
    // even respond, masking that attempt's real failure reason.
    const clock = new FakeClock();
    let attempts = 0;
    await assert.rejects(
      withBudgetedRetry(
        { clock, budgetMs: 260, baseDelayMs: 100, isRetryable: () => true },
        async () => {
          attempts++;
          throw new RetryableError(`attempt ${attempts}`);
        },
      ),
      (error: unknown) => error instanceof RetryableError && error.message === "attempt 1",
    );
    // 260ms remains after attempt 1 — comfortably positive, and even more
    // than the 100ms backoff itself — but 100ms of backoff plus the 250ms
    // floor exceeds it, so it gives up rather than leaving the next attempt
    // only ~160ms to work with.
    assert.equal(attempts, 1);
  });

  it("retries with exponential backoff bounded by the budget, then gives up", async () => {
    const clock = new FakeClock();
    const sleeps: number[] = [];
    const originalSleep = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      sleeps.push(ms);
      await originalSleep(ms);
    };

    let attempts = 0;
    await assert.rejects(
      withBudgetedRetry(
        { clock, budgetMs: 1000, baseDelayMs: 100, isRetryable: () => true },
        async () => {
          attempts++;
          throw new RetryableError(`attempt ${attempts}`);
        },
      ),
      (error: unknown) => error instanceof RetryableError && error.message === "attempt 4",
    );

    // 100, 200, 400 all fit within what's left after the attempt that
    // preceded them; the next backoff (800) would not fit in what's left
    // after attempt 4 (300), so it gives up there instead of sleeping.
    assert.deepEqual(sleeps, [100, 200, 400]);
    assert.equal(attempts, 4);
  });

  it("passes the shrinking remaining budget into each attempt", async () => {
    const clock = new FakeClock();
    const remainingSeen: number[] = [];
    let attempts = 0;
    await assert.rejects(
      withBudgetedRetry(
        { clock, budgetMs: 1000, baseDelayMs: 100, isRetryable: () => true },
        async (remainingMs) => {
          remainingSeen.push(remainingMs);
          attempts++;
          throw new RetryableError("fail");
        },
      ),
    );

    assert.equal(remainingSeen[0], 1000);
    assert.ok(remainingSeen[1] !== undefined && remainingSeen[1] < 1000);
    assert.ok(attempts > 1);
  });

  it("always passes an integer remainingMs, even when elapsed() is fractional", async () => {
    // AbortSignal.timeout() — what client.ts ultimately hands remainingMs to
    // — throws RangeError on a non-integer, and a real monotonic clock
    // (performance.now()) returns fractional milliseconds.
    let fakeElapsed = 0;
    const clock = {
      now: () => 0,
      elapsed: () => fakeElapsed,
      sleep: async (ms: number) => {
        fakeElapsed += ms;
      },
    };

    const remainingSeen: number[] = [];
    let attempts = 0;
    await assert.rejects(
      withBudgetedRetry(
        { clock, budgetMs: 2000.7, baseDelayMs: 10, isRetryable: () => true },
        async (remainingMs) => {
          remainingSeen.push(remainingMs);
          attempts++;
          fakeElapsed += 0.6543;
          throw new RetryableError("fail");
        },
      ),
    );

    assert.ok(attempts > 1);
    for (const remainingMs of remainingSeen) {
      assert.equal(remainingMs, Math.trunc(remainingMs));
    }
  });
});
