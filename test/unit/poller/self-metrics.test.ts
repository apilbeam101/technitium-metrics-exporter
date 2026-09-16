import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { PollCycleTracker } from "../../../src/poller/cache.ts";
import { SelfMetrics } from "../../../src/poller/self-metrics.ts";
import { FakeClock } from "../../support/fake-clock.ts";

interface JsonMetric {
  readonly name: string;
  readonly type: string;
  readonly values: ReadonlyArray<{
    readonly value: number;
    readonly labels: Record<string, string>;
    readonly metricName?: string;
  }>;
}

async function metricsByName(registry: Registry): Promise<Map<string, JsonMetric>> {
  const metrics = (await registry.getMetricsAsJSON()) as JsonMetric[];
  return new Map(metrics.map((m) => [m.name, m]));
}

describe("SelfMetrics", () => {
  it("registers every D§5.7 per-target series with the right type, except cache_age_seconds which is absent pre-first-cycle", async () => {
    const registry = new Registry();
    new SelfMetrics(registry, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });

    const byName = await metricsByName(registry);
    assert.equal(
      byName.get("technitium_exporter_last_successful_poll_timestamp_seconds")?.type,
      "gauge",
    );
    assert.equal(byName.get("technitium_exporter_cache_age_seconds"), undefined);
    assert.equal(byName.get("technitium_exporter_poll_total")?.type, "counter");
    assert.equal(byName.get("technitium_exporter_poll_errors_total")?.type, "counter");
    assert.equal(byName.get("technitium_exporter_poll_duration_seconds")?.type, "histogram");
    assert.equal(byName.get("technitium_exporter_upstream_requests_total")?.type, "counter");
    assert.equal(
      byName.get("technitium_exporter_upstream_request_duration_seconds")?.type,
      "histogram",
    );
    assert.equal(byName.get("technitium_exporter_parse_errors_total")?.type, "counter");
    assert.equal(byName.get("technitium_exporter_series")?.type, "gauge");
    assert.equal(byName.get("technitium_exporter_tls_verification_disabled")?.type, "gauge");
  });

  it("sets tls_verification_disabled from the constructor option, once, for each boolean value", async () => {
    const enabled = new Registry();
    new SelfMetrics(enabled, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: true,
      pollTracker: new PollCycleTracker(),
    });
    const enabledMetrics = await metricsByName(enabled);
    assert.equal(
      enabledMetrics.get("technitium_exporter_tls_verification_disabled")?.values[0]?.value,
      1,
    );

    const disabled = new Registry();
    new SelfMetrics(disabled, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });
    const disabledMetrics = await metricsByName(disabled);
    assert.equal(
      disabledMetrics.get("technitium_exporter_tls_verification_disabled")?.values[0]?.value,
      0,
    );
  });

  it("increments poll_total and observes poll_duration_seconds on every cycle, success or failure", async () => {
    const registry = new Registry();
    const clock = new FakeClock();
    const selfMetrics = new SelfMetrics(registry, {
      clock,
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });

    selfMetrics.recordPollCycle("success", 250);
    selfMetrics.recordPollCycle("failure", 750);

    const byName = await metricsByName(registry);
    assert.equal(byName.get("technitium_exporter_poll_total")?.values[0]?.value, 2);

    const duration = byName.get("technitium_exporter_poll_duration_seconds");
    const sum = duration?.values.find((v) => v.metricName?.endsWith("_sum"))?.value;
    const count = duration?.values.find((v) => v.metricName?.endsWith("_count"))?.value;
    assert.equal(sum, 1);
    assert.equal(count, 2);
  });

  it("sets last_successful_poll_timestamp_seconds from the wall clock only on a success outcome", async () => {
    const registry = new Registry();
    const clock = new FakeClock(1_700_000_000_000);
    const selfMetrics = new SelfMetrics(registry, {
      clock,
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });

    selfMetrics.recordPollCycle("failure", 10);
    let byName = await metricsByName(registry);
    assert.equal(
      byName.get("technitium_exporter_last_successful_poll_timestamp_seconds")?.values[0]?.value,
      0,
    );

    clock.advance(5_000);
    selfMetrics.recordPollCycle("success", 10);
    byName = await metricsByName(registry);
    assert.equal(
      byName.get("technitium_exporter_last_successful_poll_timestamp_seconds")?.values[0]?.value,
      1_700_000_005_000 / 1000,
    );
  });

  it("labels poll_errors_total by reason and parse_errors_total by group", async () => {
    const registry = new Registry();
    const selfMetrics = new SelfMetrics(registry, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });

    selfMetrics.recordPollError("timeout");
    selfMetrics.recordPollError("timeout");
    selfMetrics.recordPollError("auth");
    selfMetrics.recordParseError("zones");

    const byName = await metricsByName(registry);
    const errors = byName.get("technitium_exporter_poll_errors_total")?.values ?? [];
    assert.equal(errors.find((v) => v.labels.reason === "timeout")?.value, 2);
    assert.equal(errors.find((v) => v.labels.reason === "auth")?.value, 1);

    const parseErrors = byName.get("technitium_exporter_parse_errors_total")?.values ?? [];
    assert.equal(parseErrors.find((v) => v.labels.group === "zones")?.value, 1);
  });

  it("labels upstream_requests_total with a real status code on a response and a bounded reason on a network/timeout failure", async () => {
    const registry = new Registry();
    const selfMetrics = new SelfMetrics(registry, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });

    selfMetrics.recordUpstreamAttempt({
      path: "/api/user/session/get",
      durationMs: 40,
      statusCode: 200,
    });
    selfMetrics.recordUpstreamAttempt({
      path: "/api/zones/list",
      durationMs: 15_000,
      reason: "timeout",
    });

    const byName = await metricsByName(registry);
    const requests = byName.get("technitium_exporter_upstream_requests_total")?.values ?? [];
    assert.equal(
      requests.find((v) => v.labels.endpoint === "/api/user/session/get")?.labels.status_code,
      "200",
    );
    assert.equal(
      requests.find((v) => v.labels.endpoint === "/api/zones/list")?.labels.status_code,
      "timeout",
    );

    const durationSum = byName
      .get("technitium_exporter_upstream_request_duration_seconds")
      ?.values.filter((v) => v.metricName?.endsWith("_sum"));
    assert.ok(durationSum?.some((v) => v.labels.endpoint === "/api/zones/list" && v.value === 15));
  });

  it("keeps cache_age_seconds genuinely absent before the target's first poll cycle has completed", async () => {
    const registry = new Registry();
    const pollTracker = new PollCycleTracker<{ readonly ok: boolean }>();
    new SelfMetrics(registry, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: false,
      pollTracker,
    });

    const byName = await metricsByName(registry);
    assert.equal(byName.get("technitium_exporter_cache_age_seconds"), undefined);
  });

  it("computes cache_age_seconds at collect time from the monotonic clock, present only once the first cycle completes", async () => {
    const registry = new Registry();
    const clock = new FakeClock();
    const pollTracker = new PollCycleTracker<{ readonly ok: boolean }>();
    const selfMetrics = new SelfMetrics(registry, {
      clock,
      tlsInsecureSkipVerify: false,
      pollTracker,
    });

    // pollTracker.record() is what target-registry.ts's buildEntry() calls
    // immediately before noteCacheFetch() on every real poll cycle — this
    // reproduces that exact ordering rather than calling noteCacheFetch() on
    // its own with nothing behind it.
    pollTracker.record({ ok: true }, clock.elapsed(), false);
    selfMetrics.noteCacheFetch();

    let byName = await metricsByName(registry);
    assert.equal(byName.get("technitium_exporter_cache_age_seconds")?.type, "gauge");
    assert.equal(byName.get("technitium_exporter_cache_age_seconds")?.values[0]?.value, 0);

    clock.advance(5_000);
    byName = await metricsByName(registry);
    assert.equal(byName.get("technitium_exporter_cache_age_seconds")?.values[0]?.value, 5);

    clock.advance(10_000);
    byName = await metricsByName(registry);
    assert.equal(byName.get("technitium_exporter_cache_age_seconds")?.values[0]?.value, 15);
  });

  it("keeps reporting cache_age_seconds after a later cycle whose fetchedAt hasn't advanced past the prior one's baseline yet", async () => {
    const registry = new Registry();
    const clock = new FakeClock();
    const pollTracker = new PollCycleTracker<{ readonly ok: boolean }>();
    const selfMetrics = new SelfMetrics(registry, {
      clock,
      tlsInsecureSkipVerify: false,
      pollTracker,
    });

    pollTracker.record({ ok: true }, clock.elapsed(), false);
    selfMetrics.noteCacheFetch();
    clock.advance(30_000);
    pollTracker.record({ ok: false }, clock.elapsed(), false);
    selfMetrics.noteCacheFetch();

    const byName = await metricsByName(registry);
    assert.equal(byName.get("technitium_exporter_cache_age_seconds")?.values[0]?.value, 0);
  });

  it("counts total series across the registry, excluding its own single series", async () => {
    const registry = new Registry();
    const selfMetrics = new SelfMetrics(registry, {
      clock: new FakeClock(),
      tlsInsecureSkipVerify: false,
      pollTracker: new PollCycleTracker(),
    });

    selfMetrics.recordPollError("timeout");
    selfMetrics.recordPollError("auth");

    const byName = await metricsByName(registry);
    const seriesCount = byName.get("technitium_exporter_series")?.values[0]?.value ?? 0;

    // Computed independently of series's own collect() logic — by directly
    // summing every other metric's own values.length from a fresh read of
    // the same registry — rather than hand-deriving how many series a
    // label-free histogram's bucket/sum/count triple contributes, which is
    // an implementation detail of @prometheus-io/client, not of this test.
    const rawMetrics = (await registry.getMetricsAsJSON()) as JsonMetric[];
    const expectedTotal = rawMetrics
      .filter((m) => m.name !== "technitium_exporter_series")
      .reduce((sum, m) => sum + m.values.length, 0);

    assert.equal(seriesCount, expectedTotal);
  });
});
