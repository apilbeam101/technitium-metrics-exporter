import type { Clock } from "../http/clock.ts";

export interface RefreshCacheOptions<T> {
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly fetch: () => Promise<T>;
  readonly initialValue: T;
  readonly onFailure?: (error: unknown) => void;
}

export interface RefreshCache<T> {
  refreshIfDue(): Promise<void>;
  getCached(): T;
}

// The independent-cadence primitive behind the cluster/statistics collectors
// (Phases 8-9): refreshIfDue() is called only from the poll path,
// getCached() only from the render path, so a slower-cadence collector never
// needs its own scheduler and a render never triggers a network call (N2).
//
// "Due" is judged from when the last refresh *started*, not when it
// finished, so a fetch that itself takes longer than intervalMs cannot
// trigger a second overlapping fetch on the next refreshIfDue() call.
export function createRefreshCache<T>(options: RefreshCacheOptions<T>): RefreshCache<T> {
  const { clock, intervalMs, fetch, onFailure } = options;
  let value = options.initialValue;
  let lastStartedAt: number | undefined;

  return {
    async refreshIfDue(): Promise<void> {
      const now = clock.now();
      if (lastStartedAt !== undefined && now - lastStartedAt < intervalMs) return;
      lastStartedAt = now;

      try {
        value = await fetch();
      } catch (error) {
        // A failed refresh retains the previous value rather than throwing:
        // the render path must still have something to serve, the same way
        // a stale-but-present cache beats an empty one.
        onFailure?.(error);
      }
    },

    getCached(): T {
      return value;
    },
  };
}
