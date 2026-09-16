import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { handleCliFlags } from "../../src/cli.ts";

describe("handleCliFlags", () => {
  it("prints the package.json version for --version and reports handled", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    let written = "";
    const handled = handleCliFlags(["--version"], (text) => {
      written += text;
    });

    assert.equal(handled, true);
    assert.equal(written.trim(), packageJson.version);
  });

  it("recognizes -v as a version shorthand", () => {
    let written = "";
    const handled = handleCliFlags(["-v"], (text) => {
      written += text;
    });
    assert.equal(handled, true);
    assert.notEqual(written, "");
  });

  it("prints help text for --help and reports handled", () => {
    let written = "";
    const handled = handleCliFlags(["--help"], (text) => {
      written += text;
    });

    assert.equal(handled, true);
    assert.match(written, /Usage: technitium-metrics-exporter/);
    assert.match(written, /--dump-raw/);
  });

  it("does not handle --dump-raw itself — it belongs to index.ts's main(), since it needs the fully loaded config", () => {
    let written = "";
    const handled = handleCliFlags(["--dump-raw"], (text) => {
      written += text;
    });

    assert.equal(handled, false);
    assert.equal(written, "");
  });

  it("does not handle unrelated arguments", () => {
    let written = "";
    const handled = handleCliFlags(["--env-file", ".env"], (text) => {
      written += text;
    });

    assert.equal(handled, false);
    assert.equal(written, "");
  });

  it("does not handle an empty argv", () => {
    let called = false;
    const handled = handleCliFlags([], () => {
      called = true;
    });
    assert.equal(handled, false);
    assert.equal(called, false);
  });
});
