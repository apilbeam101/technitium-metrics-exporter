import type { Clock } from "../http/clock.ts";

export interface TargetPollerOptions {
  readonly clock: Clock;
  readonly pollIntervalMs: number;
  readonly runCycle: () => Promise<void>;
  // Injectable so a test can assert the jitter bound without depending on
  // Math.random(); defaults to a bounded random delay so N targets started
  // together don't all hit the upstream API in the same instant.
  readonly jitter?: () => number;
}

// Bounded independently of pollIntervalMs: jitter only needs to spread N
// targets' first calls apart by a few seconds, not by a fraction of however
// long the configured poll interval is — a uniform draw over the full
// interval would mean a mean delay of ~12 hours before the first upstream
// call at the legal max POLL_INTERVAL_SECONDS=86400, which breaks a
// readinessProbe and leaves technitium_up absent (not 0) for that whole
// window.
const MAX_STARTUP_JITTER_MS = 5_000;

// A self-scheduling loop driven entirely by the injected clock: each cycle
// is awaited to completion before the next sleep is even computed, so cycles
// structurally cannot overlap — there is no setInterval that could fire again
// while a previous cycle is still in flight.
export class TargetPoller {
  readonly #clock: Clock;
  readonly #pollIntervalMs: number;
  readonly #runCycle: () => Promise<void>;
  readonly #jitter: () => number;

  #stopped = true;
  #loopPromise: Promise<void> | undefined;
  #cycleCount = 0;
  #cycleWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  // Tracks whichever clock.sleep() call is currently in flight so stop() can
  // abort it directly, instead of racing it against a separate stop signal
  // and leaving the loser (the real setTimeout underneath) alive for the
  // rest of its duration — see clock.ts's sleep() for the cancellation side.
  #sleepAbort: AbortController | undefined;

  constructor(options: TargetPollerOptions) {
    this.#clock = options.clock;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#runCycle = options.runCycle;
    this.#jitter =
      options.jitter ??
      (() => Math.random() * Math.min(options.pollIntervalMs, MAX_STARTUP_JITTER_MS));
  }

  get cycleCount(): number {
    return this.#cycleCount;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#loopPromise = this.#loop();
  }

  // Aborts whichever sleep is currently in flight, so a shutdown mid-sleep
  // doesn't have to wait out the rest of a (potentially long) poll interval
  // and doesn't leave that sleep's underlying timer alive either — but a
  // cycle already in flight is still awaited to completion in #loop below,
  // so shutdown is prompt without ever aborting a request that's actually in
  // progress.
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#sleepAbort?.abort();
    await this.#loopPromise;
  }

  // Resolves once at least `count` cycles have completed. Exists because
  // FakeClock's sleep() resolves immediately rather than waiting in real
  // time, so a test driving this loop needs a way to observe progress other
  // than wall-clock time — the same "when to poll" vs. "what's observable"
  // split refresh-cache.ts's refreshIfDue()/getCached() makes for its own
  // primitive.
  waitForCycle(count: number): Promise<void> {
    if (this.#cycleCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#cycleWaiters.push({ count, resolve });
    });
  }

  async #loop(): Promise<void> {
    await this.#sleep(this.#jitter());

    while (!this.#stopped) {
      await this.#runCycle();
      this.#cycleCount++;
      this.#notifyCycleWaiters();

      if (this.#stopped) break;
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  async #sleep(ms: number): Promise<void> {
    this.#sleepAbort = new AbortController();
    await this.#clock.sleep(ms, this.#sleepAbort.signal);
  }

  #notifyCycleWaiters(): void {
    this.#cycleWaiters = this.#cycleWaiters.filter((waiter) => {
      if (this.#cycleCount < waiter.count) return true;
      waiter.resolve();
      return false;
    });
  }
}
