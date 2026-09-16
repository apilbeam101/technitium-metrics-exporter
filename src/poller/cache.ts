export interface CacheEntry<T> {
  readonly value: T;
  readonly fetchedAt: number;
}

export function createCacheEntry<T>(value: T, fetchedAt: number): CacheEntry<T> {
  return Object.freeze({ value, fetchedAt });
}

// Backs /readyz: a poll cycle counts as "completed" whether it succeeded or
// failed (N3 — a permanently-down target must not withhold readiness from
// every other target's own render), but a cycle that returned zero results
// because parsing failed must not be recorded as if it were an ordinary
// success, so callers can tell "never polled" apart from "polled and choked
// on the response" without a separate side channel.
export class PollCycleTracker<T> {
  #completedCycles = 0;
  #parseErrorCycles = 0;
  #lastEntry: CacheEntry<T> | undefined;

  record(value: T, fetchedAt: number, hadParseError: boolean): void {
    this.#completedCycles++;
    if (hadParseError) this.#parseErrorCycles++;
    this.#lastEntry = createCacheEntry(value, fetchedAt);
  }

  get hasCompletedCycle(): boolean {
    return this.#completedCycles > 0;
  }

  get completedCycles(): number {
    return this.#completedCycles;
  }

  get parseErrorCycles(): number {
    return this.#parseErrorCycles;
  }

  get lastEntry(): CacheEntry<T> | undefined {
    return this.#lastEntry;
  }
}
