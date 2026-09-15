import type { Clock } from "./clock.ts";

export interface BudgetedRetryOptions {
  readonly clock: Clock;
  readonly budgetMs: number;
  readonly isRetryable: (error: unknown) => boolean;
  readonly baseDelayMs?: number;
}

const DEFAULT_BASE_DELAY_MS = 200;

// A retryable failure this client actually retries (network/timeout/http_5xx)
// resolves in, at most, tens of milliseconds against a live server — this
// floor is deliberately far above that, so a retry is only taken when the
// attempt following it has a genuine window to complete rather than being
// aborted by the budget before the server can even respond. Requiring only
// *some* positive time left (rather than a real floor) leaves a window,
// scaled to network latency, in which a retry is taken anyway and its
// attempt times out before finishing — masking the retryable failure's own
// reason as "timeout".
const MIN_ATTEMPT_BUDGET_MS = 250;

// The budget itself bounds the number of attempts: a retry is only taken
// when both it and the backoff before it leave at least MIN_ATTEMPT_BUDGET_MS
// of real budget for the attempt that follows.
export async function withBudgetedRetry<T>(
  options: BudgetedRetryOptions,
  attempt: (remainingBudgetMs: number) => Promise<T>,
): Promise<T> {
  const { clock, budgetMs, isRetryable, baseDelayMs = DEFAULT_BASE_DELAY_MS } = options;
  const startedAt = clock.elapsed();

  for (let attemptNumber = 1; ; attemptNumber++) {
    // Floored to a whole millisecond: elapsed() is backed by a monotonic
    // clock (performance.now()) that returns fractional milliseconds, and
    // AbortSignal.timeout() — what remainingMs is ultimately handed to —
    // throws RangeError on a non-integer. The first attempt always runs
    // regardless of how little budget is left; only a *retry* is gated on
    // MIN_ATTEMPT_BUDGET_MS below, so this can be less than that floor.
    const remainingMs = Math.floor(budgetMs - (clock.elapsed() - startedAt));

    try {
      return await attempt(remainingMs);
    } catch (error) {
      const remainingAfterAttempt = Math.floor(budgetMs - (clock.elapsed() - startedAt));

      if (!isRetryable(error) || remainingAfterAttempt < MIN_ATTEMPT_BUDGET_MS) throw error;

      const backoffMs = baseDelayMs * 2 ** (attemptNumber - 1);
      if (backoffMs + MIN_ATTEMPT_BUDGET_MS > remainingAfterAttempt) throw error;

      await clock.sleep(backoffMs);
    }
  }
}
