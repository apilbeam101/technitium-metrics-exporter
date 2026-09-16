import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";
import { ZoneCollector } from "../../../src/metrics/zone-collector.ts";

const ZONES_LIST = readFileSync("test/fixtures/zones/zones-list.json", "utf8");
const ZONES_LIST_EMPTY = readFileSync("test/fixtures/zones/zones-list-empty.json", "utf8");
const API_ERROR = readFileSync("test/fixtures/session/envelope-error.json", "utf8");

function stubClient(body: string | (() => Promise<never>)) {
  return {
    get: async () => {
      if (typeof body === "function") return body();
      return { statusCode: 200, body };
    },
  };
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

function buildCollector(
  registry: Registry,
  body: string | (() => Promise<never>),
  includeInternal = false,
): ZoneCollector {
  return new ZoneCollector({
    httpClient: stubClient(body),
    registry,
    collectorSuccess: sharedCollectorSuccess(registry),
    unknownEnum: sharedUnknownEnum(registry),
    includeInternal,
  });
}

async function valuesOfIfPresent(registry: Registry, name: string) {
  const metrics = await registry.getMetricsAsJSON();
  return metrics.find((m) => m.name === name)?.values ?? [];
}

async function valueOfMetric(registry: Registry, name: string): Promise<number | undefined> {
  return (await valuesOfIfPresent(registry, name))[0]?.value;
}

describe("ZoneCollector.collect", () => {
  it("exports all fourteen fixture zones minus the four internal ones as per-zone series", async () => {
    const registry = new Registry();
    const result = await buildCollector(registry, ZONES_LIST).collect();

    assert.equal(result.kind, "success");
    const serials = (await registry.getMetricsAsJSON()).find(
      (m) => m.name === "technitium_zone_soa_serial",
    );
    assert.equal(serials?.values.length, 10);
    assert.equal(await valueOfMetric(registry, "technitium_zones_visible"), 14);
    assert.equal(await valueOfMetric(registry, "technitium_zones_excluded_internal"), 4);
  });

  it("includes the four internal zones when includeInternal is true", async () => {
    const registry = new Registry();
    const result = await buildCollector(registry, ZONES_LIST, true).collect();

    assert.equal(result.kind, "success");
    const serials = (await registry.getMetricsAsJSON()).find(
      (m) => m.name === "technitium_zone_soa_serial",
    );
    assert.equal(serials?.values.length, 14);
    assert.equal(await valueOfMetric(registry, "technitium_zones_excluded_internal"), 0);
  });

  it("handles an empty zone list", async () => {
    const registry = new Registry();
    const result = await buildCollector(registry, ZONES_LIST_EMPTY).collect();

    assert.equal(result.kind, "success");
    assert.equal(await valueOfMetric(registry, "technitium_zones_visible"), 0);
    assert.equal(await valueOfMetric(registry, "technitium_zones_excluded_internal"), 0);
  });

  it("sets collector_success to 0 and reason api_error on a status: error envelope", async () => {
    const registry = new Registry();
    const result = await buildCollector(registry, API_ERROR).collect();

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.equal(result.reason, "api_error");
    assert.equal(await valueOfMetric(registry, "technitium_collector_success"), 0);
  });

  it("sets collector_success to 0 for an unreachable target", async () => {
    const registry = new Registry();
    const result = await buildCollector(registry, () => {
      throw new TechnitiumHttpError("network", "connection refused");
    }).collect();

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.equal(result.reason, "network");
    const metrics = await registry.getMetricsAsJSON();
    const success = metrics.find((m) => m.name === "technitium_collector_success")?.values ?? [];
    assert.deepEqual(success, [{ value: 0, labels: { collector: "zones" } }]);
  });

  it("clears the zone inventory to genuinely absent, not frozen, when a target goes from reachable to unreachable", async () => {
    const registry = new Registry();
    const collectorSuccess = sharedCollectorSuccess(registry);
    const unknownEnum = sharedUnknownEnum(registry);
    let body: string | (() => Promise<never>) = ZONES_LIST;
    const collector = new ZoneCollector({
      httpClient: {
        get: async () => (typeof body === "function" ? body() : { statusCode: 200, body }),
      },
      registry,
      collectorSuccess,
      unknownEnum,
      includeInternal: false,
    });

    await collector.collect();
    assert.equal(await valueOfMetric(registry, "technitium_zones_visible"), 14);

    body = () => {
      throw new TechnitiumHttpError("network", "connection refused");
    };
    const result = await collector.collect();

    assert.equal(result.kind, "failure");
    assert.deepEqual(await valuesOfIfPresent(registry, "technitium_zones_visible"), []);
    const serials = (await registry.getMetricsAsJSON()).find(
      (m) => m.name === "technitium_zone_soa_serial",
    );
    assert.deepEqual(serials?.values ?? [], []);
  });

  it("drops a zone removed between two poll cycles", async () => {
    const registry = new Registry();
    const collectorSuccess = sharedCollectorSuccess(registry);
    const unknownEnum = sharedUnknownEnum(registry);
    let body = ZONES_LIST;
    const collector = new ZoneCollector({
      httpClient: { get: async () => ({ statusCode: 200, body }) },
      registry,
      collectorSuccess,
      unknownEnum,
      includeInternal: false,
    });

    await collector.collect();
    assert.equal(await valueOfMetric(registry, "technitium_zones_visible"), 14);

    body = ZONES_LIST_EMPTY;
    const result = await collector.collect();

    assert.equal(result.kind, "success");
    assert.equal(await valueOfMetric(registry, "technitium_zones_visible"), 0);
    const serials = (await registry.getMetricsAsJSON()).find(
      (m) => m.name === "technitium_zone_soa_serial",
    );
    assert.deepEqual(serials?.values ?? [], []);
  });
});
