import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseNativeMetricsText } from "../../../src/api/native-text.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

const CURRENT_NAMES = readFileSync("test/fixtures/native/metrics-text-current-names.txt", "utf8");
const LEGACY_NAMES = readFileSync("test/fixtures/native/metrics-text-legacy-names.txt", "utf8");
const UNKNOWN_METRIC = readFileSync("test/fixtures/native/metrics-text-unknown-metric.txt", "utf8");
const ERROR_BODY = readFileSync("test/fixtures/native/metrics-text-error.json", "utf8");

describe("parseNativeMetricsText", () => {
  it("parses every current-spelling counter", () => {
    const counters = parseNativeMetricsText(CURRENT_NAMES);
    assert.equal(counters.queriesTotal, 100000);
    assert.equal(counters.noErrorTotal, 90000);
    assert.equal(counters.serverFailureTotal, 500);
    assert.equal(counters.nxDomainTotal, 4000);
    assert.equal(counters.refusedTotal, 100);
    assert.equal(counters.authoritativeTotal, 60000);
    assert.equal(counters.recursiveTotal, 40000);
    assert.equal(counters.cachedTotal, 30000);
    assert.equal(counters.blockedTotal, 5000);
    assert.equal(counters.droppedTotal, 100);
    assert.equal(counters.clientsTotal, 250);
    assert.equal(counters.uptimeSeconds, 12345);
    assert.equal(counters.unknownMetricNames.length, 0);
  });

  it("converts start_time from milliseconds to seconds", () => {
    const counters = parseNativeMetricsText(CURRENT_NAMES);
    assert.equal(counters.startTimeSeconds, 1700000000000 / 1000);
  });

  it("produces identical counters from either upstream spelling (R5, N8)", () => {
    const current = parseNativeMetricsText(CURRENT_NAMES);
    const legacy = parseNativeMetricsText(LEGACY_NAMES);
    assert.deepEqual(current, legacy);
  });

  it("reports an unrecognized metric name without breaking the rest of the parse", () => {
    const counters = parseNativeMetricsText(UNKNOWN_METRIC);
    assert.deepEqual(counters.unknownMetricNames, ["future_metric_not_yet_mapped"]);
    assert.equal(counters.queriesTotal, 100000);
  });

  it("throws a TechnitiumHttpError with reason api_error on the JSON error body, producing no counters", () => {
    assert.throws(
      () => parseNativeMetricsText(ERROR_BODY),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "api_error",
    );
  });

  it("throws a TechnitiumHttpError with reason auth on an invalid-token JSON body", () => {
    const body = JSON.stringify({ status: "invalid-token" });
    assert.throws(
      () => parseNativeMetricsText(body),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "auth",
    );
  });

  it("throws a TechnitiumHttpError with reason parse on a malformed data line", () => {
    assert.throws(
      () => parseNativeMetricsText("queries_total not-a-number"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });

  it("throws a TechnitiumHttpError with reason parse on a negative value, never a raw prom-client throw", () => {
    assert.throws(
      () =>
        parseNativeMetricsText("uptime_seconds 12345\nstart_time 1700000000000\nqueries_total -1"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });

  it("leaves a known counter undefined, rather than throwing, when it is missing from an otherwise well-formed response (D§5.4: an in-progress upstream rename)", () => {
    const withoutQueries = CURRENT_NAMES.split("\n")
      .filter((line) => !line.includes("queries_total"))
      .join("\n");
    const counters = parseNativeMetricsText(withoutQueries);
    assert.equal(counters.queriesTotal, undefined);
    assert.equal(counters.noErrorTotal, 90000);
  });

  it("leaves uptimeSeconds/startTimeSeconds undefined, rather than throwing, when either is missing", () => {
    const withoutUptime = CURRENT_NAMES.split("\n")
      .filter((line) => !line.includes("uptime_seconds"))
      .join("\n");
    const counters = parseNativeMetricsText(withoutUptime);
    assert.equal(counters.uptimeSeconds, undefined);
    assert.equal(counters.startTimeSeconds, 1700000000000 / 1000);
  });

  it("increments the unknown-metric list for a renamed counter while every other field still parses", () => {
    const renamed = CURRENT_NAMES.replace("queries_total 100000", "queries_total_v2 100000");
    const counters = parseNativeMetricsText(renamed);
    assert.deepEqual(counters.unknownMetricNames, ["queries_total_v2"]);
    assert.equal(counters.queriesTotal, undefined);
    assert.equal(counters.noErrorTotal, 90000);
  });

  it("skips a comment line even if it would otherwise tokenize as a valid two-token data line", () => {
    // "# 123" tokenizes to exactly two tokens ["#", "123"], the same shape as
    // a real data line — if the "#"-prefix check weren't applied before the
    // grammar check, this would silently register a bogus "#"-named metric
    // instead of being skipped as a comment.
    const counters = parseNativeMetricsText(
      "# 123\nuptime_seconds 12345\nstart_time 1700000000000\n",
    );
    assert.equal(counters.uptimeSeconds, 12345);
    assert.equal(counters.unknownMetricNames.length, 0);
  });

  it("keeps the last value when the same name appears twice in one response", () => {
    const counters = parseNativeMetricsText(
      "uptime_seconds 12345\nstart_time 1700000000000\nqueries_total 1\nqueries_total 2\n",
    );
    assert.equal(counters.queriesTotal, 2);
  });

  it("resolves in document order, not spelling order, when both spellings appear in one response (e.g. mid-migration)", () => {
    const counters = parseNativeMetricsText(
      "uptime_seconds 12345\nstart_time 1700000000000\ntotal_queries 1\nqueries_total 2\n",
    );
    assert.equal(counters.queriesTotal, 2);
  });
});
