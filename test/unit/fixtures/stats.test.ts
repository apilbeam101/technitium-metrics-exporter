import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

interface ChartData {
  labels: string[];
  datasets: { data: number[] }[];
}

interface StatsFixture {
  response: {
    protocolTypeChartData: ChartData;
    queryResponseChartData: ChartData;
    queryTypeChartData: ChartData;
  };
}

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures", "stats");

function load(name: string): StatsFixture {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as StatsFixture;
}

function assertZipped(chart: ChartData): void {
  const data = chart.datasets[0]?.data;
  assert.ok(data !== undefined);
  assert.equal(chart.labels.length, data.length);
}

describe("stats/get full-coverage fixture", () => {
  const fixture = load("stats-get-full.json");

  it("reports all five transport protocols", () => {
    assert.deepEqual(
      new Set(fixture.response.protocolTypeChartData.labels),
      new Set(["Udp", "Tcp", "Tls", "Https", "Quic"]),
    );
  });

  it("reports all five response types", () => {
    assert.deepEqual(
      new Set(fixture.response.queryResponseChartData.labels),
      new Set(["Authoritative", "Recursive", "Cached", "Blocked", "Dropped"]),
    );
  });

  it("keeps labels and data positionally zipped", () => {
    assertZipped(fixture.response.protocolTypeChartData);
    assertZipped(fixture.response.queryResponseChartData);
    assertZipped(fixture.response.queryTypeChartData);
  });
});

describe("stats/get single-label fixture", () => {
  const fixture = load("stats-get-single-label.json");

  it("has exactly one label in protocolTypeChartData, exercising the sparse-array hazard", () => {
    assert.equal(fixture.response.protocolTypeChartData.labels.length, 1);
    assertZipped(fixture.response.protocolTypeChartData);
  });

  it("does not report a protocol with zero traffic as a zero-valued entry", () => {
    const { labels } = fixture.response.protocolTypeChartData;
    assert.equal(labels.includes("Tcp"), false);
    assert.equal(labels.includes("Tls"), false);
    assert.equal(labels.includes("Https"), false);
    assert.equal(labels.includes("Quic"), false);
  });
});
