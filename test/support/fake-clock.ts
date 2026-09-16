import type { Clock } from "../../src/http/clock.ts";

// sleep() advances the same counter elapsed() reads, instead of waiting in
// real time, so retry/backoff behaviour is testable without slow tests.
export class FakeClock implements Clock {
  #elapsedMs = 0;
  #nowMs: number;

  constructor(initialNowMs = 0) {
    this.#nowMs = initialNowMs;
  }

  now(): number {
    return this.#nowMs;
  }

  elapsed(): number {
    return this.#elapsedMs;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return;
    this.#elapsedMs += ms;
    this.#nowMs += ms;
  }

  advance(ms: number): void {
    this.#elapsedMs += ms;
    this.#nowMs += ms;
  }
}
