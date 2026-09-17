import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateDashboard } from "../../../scripts/generate-dashboard.ts";

const COMMITTED_DASHBOARD = readFileSync("dashboards/technitium-dns.json", "utf8");

describe("generate-dashboard", () => {
  // Mirrors generate-metrics-doc.test.ts's own drift check: dashboards/
  // technitium-dns.json must be byte-for-byte what the generator produces
  // right now, so a panel change that isn't accompanied by regenerating the
  // file (node --experimental-strip-types scripts/generate-dashboard.ts)
  // fails this test instead of drifting silently.
  it("matches the committed dashboards/technitium-dns.json byte-for-byte", () => {
    const generated = generateDashboard();
    assert.equal(generated, COMMITTED_DASHBOARD);
  });

  it("produces valid JSON with the exporter-health row first", () => {
    const parsed = JSON.parse(generateDashboard()) as {
      panels: Array<{ type: string; title: string }>;
    };
    const firstRow = parsed.panels.find((p) => p.type === "row");
    assert.equal(firstRow?.title, "Exporter health");
  });

  it("gives every panel a unique id", () => {
    const parsed = JSON.parse(generateDashboard()) as { panels: Array<{ id: number }> };
    const ids = parsed.panels.map((p) => p.id);
    assert.equal(ids.length, new Set(ids).size);
  });
});
