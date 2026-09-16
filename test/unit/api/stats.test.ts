import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseStatsGetResponse } from "../../../src/api/stats.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

const STATS_FULL = readFileSync("test/fixtures/stats/stats-get-full.json", "utf8");
const STATS_SINGLE_LABEL = readFileSync("test/fixtures/stats/stats-get-single-label.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");
const API_ERROR = readFileSync("test/fixtures/session/envelope-error.json", "utf8");

describe("parseStatsGetResponse", () => {
  it("zips protocolTypeChartData's labels and data positionally", () => {
    const detail = parseStatsGetResponse(STATS_FULL);
    assert.equal(detail.queriesByProtocol.get("Udp"), 80000);
    assert.equal(detail.queriesByProtocol.get("Tcp"), 15000);
    assert.equal(detail.queriesByProtocol.get("Tls"), 2000);
    assert.equal(detail.queriesByProtocol.get("Https"), 2500);
    assert.equal(detail.queriesByProtocol.get("Quic"), 500);
  });

  it("zips queryResponseChartData's labels and data positionally", () => {
    const detail = parseStatsGetResponse(STATS_FULL);
    assert.equal(detail.queriesByResponseType.get("Authoritative"), 60000);
    assert.equal(detail.queriesByResponseType.get("Dropped"), 100);
  });

  it("zips queryTypeChartData's labels and data positionally", () => {
    const detail = parseStatsGetResponse(STATS_FULL);
    assert.equal(detail.queryTypes.get("A"), 50000);
    assert.equal(detail.queryTypes.get("DNSKEY"), 500);
  });

  it("reads the D§5.3 zone total and the D§5.5 live-state fields from the stats object", () => {
    const detail = parseStatsGetResponse(STATS_FULL);
    assert.equal(detail.zonesReported, 11);
    assert.equal(detail.cachedEntries, 1200);
    assert.equal(detail.allowedZones, 0);
    assert.equal(detail.blockedZones, 3);
    assert.equal(detail.allowListZones, 0);
    assert.equal(detail.blockListZones, 1);
  });

  it("does not report a protocol with zero traffic as a zero-valued map entry, exercising the single-label sparse fixture", () => {
    const detail = parseStatsGetResponse(STATS_SINGLE_LABEL);
    assert.equal(detail.queriesByProtocol.size, 1);
    assert.equal(detail.queriesByProtocol.get("Udp"), 100);
    assert.equal(detail.queriesByProtocol.has("Tcp"), false);
  });

  it("throws a TechnitiumHttpError with reason parse on a labels/data length mismatch", () => {
    const raw = JSON.parse(STATS_FULL) as {
      response: { protocolTypeChartData: { labels: string[] } };
    };
    raw.response.protocolTypeChartData.labels.push("Extra");

    assert.throws(
      () => parseStatsGetResponse(JSON.stringify(raw)),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });

  it("leaves every stats field undefined when the response omits the stats object entirely", () => {
    const raw = JSON.parse(STATS_FULL) as { response: Record<string, unknown> };
    delete raw.response.stats;

    const detail = parseStatsGetResponse(JSON.stringify(raw));
    assert.equal(detail.zonesReported, undefined);
    assert.equal(detail.cachedEntries, undefined);
    assert.equal(detail.allowedZones, undefined);
    assert.equal(detail.blockedZones, undefined);
    assert.equal(detail.allowListZones, undefined);
    assert.equal(detail.blockListZones, undefined);
  });

  it("never exposes the stats object's own lifetime-counter fields, which duplicate metrics/text (D§5.4)", () => {
    const detail = parseStatsGetResponse(STATS_FULL) as unknown as Record<string, unknown>;
    assert.equal(detail.totalQueries, undefined);
    assert.equal(detail.stats, undefined);
  });

  it("throws a TechnitiumHttpError with reason auth on an invalid-token envelope", () => {
    assert.throws(
      () => parseStatsGetResponse(INVALID_TOKEN),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "auth",
    );
  });

  it("throws a TechnitiumHttpError with reason api_error on a status: error envelope", () => {
    assert.throws(
      () => parseStatsGetResponse(API_ERROR),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "api_error",
    );
  });

  it("throws a TechnitiumHttpError with reason parse on a non-JSON body", () => {
    assert.throws(
      () => parseStatsGetResponse("not json at all"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });
});
