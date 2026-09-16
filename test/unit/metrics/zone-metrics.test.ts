import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { Zone } from "../../../src/domain/zone.ts";
import {
  applyZoneFailure,
  applyZoneSuccess,
  createZoneMetrics,
} from "../../../src/metrics/zone-metrics.ts";

async function valuesOf(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === name);
  assert.ok(metric, `no metric registered named ${name}`);
  return metric.values;
}

// technitium_zones_visible and technitium_zones_excluded_internal have no
// label dimension, so an absent series can only be achieved by not
// registering them at all — they may legitimately be missing from the
// registry entirely (before the first successful poll, or after a failure),
// unlike the always-registered metrics valuesOf() above asserts on.
async function valuesOfIfPresent(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values ?? [];
}

function sharedCollectorSuccess(registry: Registry): Gauge<"collector"> {
  return new Gauge<"collector">({
    name: "technitium_collector_success",
    help: "Per-collector outcome of the last poll cycle",
    labelNames: ["collector"],
    registers: [registry],
  });
}

function sharedUnknownEnum(registry: Registry): Counter<"metric" | "value"> {
  return new Counter<"metric" | "value">({
    name: "technitium_exporter_unknown_enum_total",
    help: "Count of enum values seen from the API that are outside this exporter's recognized set",
    labelNames: ["metric", "value"],
    registers: [registry],
  });
}

function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    name: "example.com",
    type: "Primary",
    disabled: false,
    dnssecStatus: "Unsigned",
    soaSerial: 2026091001,
    lastModifiedSeconds: 1000,
    internal: false,
    expirySeconds: undefined,
    isExpired: undefined,
    syncFailed: undefined,
    notifyFailed: false,
    notifyFailedPeerCount: 0,
    ...overrides,
  };
}

function build(registry: Registry) {
  return createZoneMetrics(registry, sharedCollectorSuccess(registry), sharedUnknownEnum(registry));
}

describe("createZoneMetrics", () => {
  it("leaves zones_visible and zones_excluded_internal genuinely absent before any poll has run", async () => {
    const registry = new Registry();
    build(registry);

    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_zones_visible"), []);
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_zones_excluded_internal"), []);
  });
});

describe("applyZoneFailure", () => {
  it("sets collector_success to 0", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneFailure(metrics);

    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(success, [{ value: 0, labels: { collector: "zones" } }]);
  });

  it("clears every zone series to genuinely absent after a prior success, not frozen at its last value", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(metrics, [zone()], false);
    assert.equal((await valuesOfIfPresent(registry, "technitium_zones_visible"))[0]?.value, 1);

    applyZoneFailure(metrics);

    assert.deepEqual(await valuesOf(registry, "technitium_zone_soa_serial"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_dnssec_status"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_zones_by_type"), []);
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_zones_visible"), []);
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_zones_excluded_internal"), []);
  });
});

describe("applyZoneSuccess", () => {
  it("sets collector_success to 1 and exports soa_serial/disabled/last_modified per zone", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [zone({ name: "example.com", soaSerial: 42, disabled: true })],
      false,
    );

    const success = await valuesOf(registry, "technitium_collector_success");
    assert.deepEqual(success, [{ value: 1, labels: { collector: "zones" } }]);

    assert.deepEqual(await valuesOf(registry, "technitium_zone_soa_serial"), [
      { value: 42, labels: { zone: "example.com", type: "Primary" } },
    ]);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_disabled"), [
      { value: 1, labels: { zone: "example.com", type: "Primary" } },
    ]);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_last_modified_timestamp_seconds"), [
      { value: 1000, labels: { zone: "example.com", type: "Primary" } },
    ]);
  });

  it("leaves last_modified genuinely absent for a zone with no parseable timestamp", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(metrics, [zone({ lastModifiedSeconds: undefined })], false);

    assert.deepEqual(
      await valuesOf(registry, "technitium_zone_last_modified_timestamp_seconds"),
      [],
    );
  });

  it("exports exactly one dnssecStatus series set to 1 per zone, out of all three candidates", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [zone({ name: "signed.example.com", dnssecStatus: "SignedWithNSEC3" })],
      false,
    );

    const statuses = await valuesOf(registry, "technitium_zone_dnssec_status");
    assert.equal(statuses.length, 3);
    const active = statuses.filter((v) => v.value === 1);
    assert.deepEqual(active, [
      { value: 1, labels: { zone: "signed.example.com", status: "SignedWithNSEC3" } },
    ]);
  });

  it("counts an unrecognized dnssecStatus exactly once without breaking the render, all three candidates at 0", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(metrics, [zone({ dnssecStatus: "SignedWithFutureAlgorithm" })], false);

    const statuses = await valuesOf(registry, "technitium_zone_dnssec_status");
    assert.equal(statuses.length, 3);
    assert.ok(statuses.every((v) => v.value === 0));

    const unknownEnum = await valuesOf(registry, "technitium_exporter_unknown_enum_total");
    assert.deepEqual(unknownEnum, [
      { value: 1, labels: { metric: "zone_dnssec_status", value: "SignedWithFutureAlgorithm" } },
    ]);
  });

  it("exports expiry/expired/sync_failed only for zones that actually report them", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [
        zone({
          name: "secondary.example.com",
          type: "Secondary",
          expirySeconds: 5000,
          isExpired: false,
          syncFailed: true,
          notifyFailed: undefined,
          notifyFailedPeerCount: undefined,
        }),
        zone({ name: "primary.example.com", type: "Primary" }),
      ],
      false,
    );

    assert.deepEqual(await valuesOf(registry, "technitium_zone_expiry_timestamp_seconds"), [
      { value: 5000, labels: { zone: "secondary.example.com", type: "Secondary" } },
    ]);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_expired"), [
      { value: 0, labels: { zone: "secondary.example.com", type: "Secondary" } },
    ]);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_sync_failed"), [
      { value: 1, labels: { zone: "secondary.example.com", type: "Secondary" } },
    ]);
  });

  it("leaves expiry genuinely absent for a secondary zone reporting isExpired without expiry", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [
        zone({
          name: "expiryless.example.com",
          type: "Secondary",
          expirySeconds: undefined,
          isExpired: true,
          syncFailed: false,
          notifyFailed: undefined,
          notifyFailedPeerCount: undefined,
        }),
      ],
      false,
    );

    assert.deepEqual(await valuesOf(registry, "technitium_zone_expiry_timestamp_seconds"), []);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_expired"), [
      { value: 1, labels: { zone: "expiryless.example.com", type: "Secondary" } },
    ]);
  });

  it("exports notify_failed and notify_failed_peers only for zones that actually report them", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [
        zone({
          name: "mail.example.com",
          type: "Primary",
          notifyFailed: true,
          notifyFailedPeerCount: 2,
        }),
        zone({
          name: "secondary.example.com",
          type: "Secondary",
          notifyFailed: undefined,
          notifyFailedPeerCount: undefined,
        }),
        zone({
          name: "localhost",
          type: "Primary",
          internal: true,
          notifyFailed: undefined,
          notifyFailedPeerCount: undefined,
        }),
      ],
      false,
    );

    assert.deepEqual(await valuesOf(registry, "technitium_zone_notify_failed"), [
      { value: 1, labels: { zone: "mail.example.com", type: "Primary" } },
    ]);
    assert.deepEqual(await valuesOf(registry, "technitium_zone_notify_failed_peers"), [
      { value: 2, labels: { zone: "mail.example.com", type: "Primary" } },
    ]);
  });

  it("excludes internal zones from every per-zone series but counts them in zones_visible/zones_by_type/zones_excluded_internal", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [
        zone({ name: "example.com", type: "Primary" }),
        zone({ name: "localhost", type: "Primary", internal: true }),
      ],
      false,
    );

    assert.deepEqual(await valuesOf(registry, "technitium_zone_soa_serial"), [
      { value: 2026091001, labels: { zone: "example.com", type: "Primary" } },
    ]);
    assert.equal((await valuesOfIfPresent(registry, "technitium_zones_visible"))[0]?.value, 2);
    assert.equal(
      (await valuesOfIfPresent(registry, "technitium_zones_excluded_internal"))[0]?.value,
      1,
    );

    const byType = await valuesOf(registry, "technitium_zones_by_type");
    const primaryCount = byType.find((v) => v.labels.type === "Primary")?.value;
    assert.equal(primaryCount, 2);
  });

  it("includes internal zones in every per-zone series when includeInternal is true, and reports zero excluded", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [
        zone({ name: "example.com", type: "Primary" }),
        zone({ name: "localhost", type: "Primary", internal: true }),
      ],
      true,
    );

    const serials = await valuesOf(registry, "technitium_zone_soa_serial");
    assert.equal(serials.length, 2);
    assert.ok(serials.some((v) => v.labels.zone === "localhost"));
    assert.equal(
      (await valuesOfIfPresent(registry, "technitium_zones_excluded_internal"))[0]?.value,
      0,
    );
  });

  it("sums technitium_zones_by_type to technitium_zones_visible across all seven types", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    const types = [
      "Primary",
      "Secondary",
      "Stub",
      "Forwarder",
      "SecondaryForwarder",
      "Catalog",
      "SecondaryCatalog",
    ];
    applyZoneSuccess(
      metrics,
      types.map((type, index) =>
        zone({
          name: `zone-${index}.example.com`,
          type,
          notifyFailed: undefined,
          notifyFailedPeerCount: undefined,
        }),
      ),
      false,
    );

    const visible = (await valuesOfIfPresent(registry, "technitium_zones_visible"))[0]?.value;
    const byType = await valuesOf(registry, "technitium_zones_by_type");
    const sum = byType.reduce((total, v) => total + v.value, 0);
    assert.equal(sum, visible);
    assert.equal(byType.length, 7);
    assert.equal(
      byType.some((v) => v.labels.type === "unrecognized"),
      false,
      "the unrecognized bucket should not appear when no zone actually falls into it",
    );
  });

  it("sums technitium_zones_by_type to technitium_zones_visible even with an unrecognized zone type present", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [
        zone({ name: "future.example.com", type: "FutureZoneType" }),
        zone({ name: "example.com", type: "Primary" }),
      ],
      false,
    );

    const visible = (await valuesOfIfPresent(registry, "technitium_zones_visible"))[0]?.value;
    const byType = await valuesOf(registry, "technitium_zones_by_type");
    const sum = byType.reduce((total, v) => total + v.value, 0);
    assert.equal(sum, visible);
    assert.equal(byType.find((v) => v.labels.type === "unrecognized")?.value, 1);
  });

  it("counts an unrecognized zone type in unknownEnum exactly once, not once per metric that uses the type", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [zone({ name: "future.example.com", type: "FutureZoneType" })],
      false,
    );

    const unknownEnum = await valuesOf(registry, "technitium_exporter_unknown_enum_total");
    assert.deepEqual(unknownEnum, [
      { value: 1, labels: { metric: "zone_type", value: "FutureZoneType" } },
    ]);
  });

  it("normalises an unrecognized zone type label to 'unrecognized' on the per-zone series", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [zone({ name: "future.example.com", type: "FutureZoneType" })],
      false,
    );

    const serials = await valuesOf(registry, "technitium_zone_soa_serial");
    assert.deepEqual(serials, [
      { value: 2026091001, labels: { zone: "future.example.com", type: "unrecognized" } },
    ]);
  });

  it("removes a zone's series entirely once it disappears from a later, otherwise-successful poll", async () => {
    const registry = new Registry();
    const metrics = build(registry);
    applyZoneSuccess(
      metrics,
      [zone({ name: "a.example.com" }), zone({ name: "b.example.com" })],
      false,
    );
    assert.equal((await valuesOf(registry, "technitium_zone_soa_serial")).length, 2);

    applyZoneSuccess(metrics, [zone({ name: "a.example.com" })], false);

    const serials = await valuesOf(registry, "technitium_zone_soa_serial");
    assert.equal(serials.length, 1);
    assert.equal(serials[0]?.labels.zone, "a.example.com");
  });
});
