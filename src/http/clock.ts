export interface Clock {
  now(): number;
  elapsed(): number;
  // signal is optional so retry.ts's unconditional callers don't need
  // updating; a caller that does pass one gets an early resolve (not a
  // rejection — an aborted sleep is a normal early wake, not a failure) with
  // its underlying timer actually cleared, rather than left to fire uselessly
  // later.
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
};
