import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefreshCache } from "../../../src/poller/refresh-cache.ts";
import { FakeClock } from "../../support/fake-clock.ts";

describe("createRefreshCache", () => {
  it("returns the initial value before any refresh happens", () => {
    const clock = new FakeClock();
    const cache = createRefreshCache({
      clock,
      intervalMs: 1000,
      fetch: async () => "fetched",
      initialValue: "initial",
    });

    assert.equal(cache.getCached(), "initial");
  });

  it("refreshes on the first call regardless of interval, and resolves to true", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const cache = createRefreshCache({
      clock,
      intervalMs: 1000,
      fetch: async () => {
        calls++;
        return "fetched";
      },
      initialValue: "initial",
    });

    const fresh = await cache.refreshIfDue();
    assert.equal(fresh, true);
    assert.equal(calls, 1);
    assert.equal(cache.getCached(), "fetched");
  });

  it("does not refresh again before the interval has elapsed, and resolves to false", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const cache = createRefreshCache({
      clock,
      intervalMs: 1000,
      fetch: async () => {
        calls++;
        return `fetch-${calls}`;
      },
      initialValue: "initial",
    });

    await cache.refreshIfDue();
    clock.advance(500);
    const fresh = await cache.refreshIfDue();

    assert.equal(fresh, false);
    assert.equal(calls, 1);
    assert.equal(cache.getCached(), "fetch-1");
  });

  it("refreshes again once the interval has elapsed, and resolves to true", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const cache = createRefreshCache({
      clock,
      intervalMs: 1000,
      fetch: async () => {
        calls++;
        return `fetch-${calls}`;
      },
      initialValue: "initial",
    });

    await cache.refreshIfDue();
    clock.advance(1000);
    const fresh = await cache.refreshIfDue();

    assert.equal(fresh, true);
    assert.equal(calls, 2);
    assert.equal(cache.getCached(), "fetch-2");
  });

  it("retains the previous value and does not throw when a refresh fails, but still resolves to true since a fetch was attempted", async () => {
    const clock = new FakeClock();
    let failures = 0;
    const cache = createRefreshCache({
      clock,
      intervalMs: 1000,
      fetch: async () => {
        throw new Error("upstream down");
      },
      initialValue: "initial",
      onFailure: () => {
        failures++;
      },
    });

    const fresh = await cache.refreshIfDue();
    assert.equal(fresh, true);
    assert.equal(cache.getCached(), "initial");
    assert.equal(failures, 1);
  });

  it("marks a refresh as due again after a failed attempt once the interval elapses", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const cache = createRefreshCache({
      clock,
      intervalMs: 1000,
      fetch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("upstream down");
        return "recovered";
      },
      initialValue: "initial",
      onFailure: () => {},
    });

    await cache.refreshIfDue();
    assert.equal(cache.getCached(), "initial");

    clock.advance(1000);
    await cache.refreshIfDue();

    assert.equal(attempts, 2);
    assert.equal(cache.getCached(), "recovered");
  });
});
