import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures", "native");

const CURRENT_NAMES = [
  "queries_total",
  "no_error_total",
  "server_failure_total",
  "nx_domain_total",
  "refused_total",
  "authoritative_total",
  "recursive_total",
  "cached_total",
  "blocked_total",
  "dropped_total",
  "clients_total",
];

const LEGACY_NAMES = [
  "total_queries",
  "total_no_error",
  "total_server_failure",
  "total_nx_domain",
  "total_refused",
  "total_authoritative",
  "total_recursive",
  "total_cached",
  "total_blocked",
  "total_dropped",
  "total_clients",
];

function parseMetricValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [name, value] = line.trim().split(/\s+/);
    if (name !== undefined && value !== undefined) values.set(name, value);
  }
  return values;
}

describe("metrics/text fixtures", () => {
  it("current-spelling fixture contains every current-spelling metric name", () => {
    const text = readFileSync(join(fixturesDir, "metrics-text-current-names.txt"), "utf8");
    const values = parseMetricValues(text);
    for (const name of [...CURRENT_NAMES, "uptime_seconds", "start_time"]) {
      assert.ok(values.has(name), `missing ${name}`);
    }
  });

  it("legacy-spelling fixture contains every legacy-spelling metric name", () => {
    const text = readFileSync(join(fixturesDir, "metrics-text-legacy-names.txt"), "utf8");
    const values = parseMetricValues(text);
    for (const name of [...LEGACY_NAMES, "uptime_seconds", "start_time"]) {
      assert.ok(values.has(name), `missing ${name}`);
    }
  });

  it("exactly two metrics carry HELP text, and they are the ones with no dual spelling", () => {
    for (const file of ["metrics-text-current-names.txt", "metrics-text-legacy-names.txt"]) {
      const text = readFileSync(join(fixturesDir, file), "utf8");
      const helpLines = text.split("\n").filter((line) => line.startsWith("# HELP"));
      assert.equal(helpLines.length, 2);
      assert.ok(helpLines.some((line) => line.includes("uptime_seconds")));
      assert.ok(helpLines.some((line) => line.includes("start_time")));
    }
  });

  it("both spellings carry identical values for every corresponding metric", () => {
    const currentValues = parseMetricValues(
      readFileSync(join(fixturesDir, "metrics-text-current-names.txt"), "utf8"),
    );
    const legacyValues = parseMetricValues(
      readFileSync(join(fixturesDir, "metrics-text-legacy-names.txt"), "utf8"),
    );

    for (let i = 0; i < CURRENT_NAMES.length; i += 1) {
      const currentName = CURRENT_NAMES[i];
      const legacyName = LEGACY_NAMES[i];
      assert.ok(currentName !== undefined && legacyName !== undefined);
      assert.equal(currentValues.get(currentName), legacyValues.get(legacyName));
    }

    assert.equal(currentValues.get("uptime_seconds"), legacyValues.get("uptime_seconds"));
    assert.equal(currentValues.get("start_time"), legacyValues.get("start_time"));
  });

  it("start_time is a millisecond-scale timestamp", () => {
    const text = readFileSync(join(fixturesDir, "metrics-text-current-names.txt"), "utf8");
    const values = parseMetricValues(text);
    const startTime = Number(values.get("start_time"));
    assert.ok(startTime > 1_000_000_000_000);
  });

  it("unknown-metric fixture contains every current-spelling metric name plus one unrecognised metric", () => {
    const text = readFileSync(join(fixturesDir, "metrics-text-unknown-metric.txt"), "utf8");
    const values = parseMetricValues(text);
    for (const name of [...CURRENT_NAMES, "uptime_seconds", "start_time"]) {
      assert.ok(values.has(name), `missing ${name}`);
    }
    assert.ok(values.has("future_metric_not_yet_mapped"));
    assert.equal(
      [...CURRENT_NAMES, "uptime_seconds", "start_time"].includes("future_metric_not_yet_mapped"),
      false,
    );
  });
});

describe("metrics/text JSON error-body fixture", () => {
  it("carries the same status/errorMessage/stackTrace shape as the shared error envelope, reachable from a metrics/text-shaped scenario", () => {
    const fixture = JSON.parse(
      readFileSync(join(fixturesDir, "metrics-text-error.json"), "utf8"),
    ) as { status: string; errorMessage: string; stackTrace: string };
    assert.equal(fixture.status, "error");
    assert.ok(fixture.errorMessage.length > 0);
    assert.ok(fixture.stackTrace.length > 0);
  });
});
