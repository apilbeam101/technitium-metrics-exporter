import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadEnv, parseEnvFile } from "../../../src/config/load.ts";

const samplePath = join(import.meta.dirname, "..", "..", "fixtures", "config", "sample.env");

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, skipping blank lines and comments", () => {
    const vars = parseEnvFile("# comment\n\nFOO=bar\nBAZ=qux\n");
    assert.deepEqual(vars, { FOO: "bar", BAZ: "qux" });
  });

  it("strips matching surrounding quotes", () => {
    const vars = parseEnvFile("A=\"double\"\nB='single'\nC=unquoted\n");
    assert.deepEqual(vars, { A: "double", B: "single", C: "unquoted" });
  });

  it("ignores lines that are not KEY=VALUE", () => {
    const vars = parseEnvFile("not a valid line\nFOO=bar\n");
    assert.deepEqual(vars, { FOO: "bar" });
  });

  it("strips an unquoted trailing inline comment, matching example.env's own style", () => {
    const vars = parseEnvFile("STATS_POLL_INTERVAL_SECONDS=300  # hard floor 60\n");
    assert.deepEqual(vars, { STATS_POLL_INTERVAL_SECONDS: "300" });
  });

  it("keeps a '#' that is part of a quoted value", () => {
    const vars = parseEnvFile('A="value#withhash"\n');
    assert.deepEqual(vars, { A: "value#withhash" });
  });

  it("keeps a '#' with no preceding whitespace, since it isn't a comment start", () => {
    const vars = parseEnvFile("A=value#nospace\n");
    assert.deepEqual(vars, { A: "value#nospace" });
  });
});

describe("loadEnv", () => {
  it("returns only the process environment when no --env-file is given", () => {
    const result = loadEnv([], { X: "y" });
    assert.deepEqual(result, { X: "y" });
  });

  it("merges a file given via --env-file, with process environment taking precedence", () => {
    const result = loadEnv(["--env-file", samplePath], { FOO: "from-process-env" });
    assert.equal(result.FOO, "from-process-env");
    assert.equal(result.BAR, "quoted-bar");
    assert.equal(result.BAZ, "baz-value");
  });

  it("supports the --env-file=<path> form", () => {
    const result = loadEnv([`--env-file=${samplePath}`], {});
    assert.equal(result.FOO, "file-foo");
  });

  it("throws when --env-file is given with no following path", () => {
    assert.throws(() => loadEnv(["--env-file"], {}), /--env-file requires a path argument/);
  });

  it("an empty-string process environment value does not mask a file-provided value", () => {
    const result = loadEnv(["--env-file", samplePath], { FOO: "" });
    assert.equal(result.FOO, "file-foo");
  });

  it("a process-env token overrides a file-provided token", () => {
    const result = loadEnv(["--env-file", samplePath], { TECHNITIUM_API_TOKEN: "process-token" });
    assert.equal(result.TECHNITIUM_API_TOKEN, "process-token");
  });

  it("falls back to a file-provided token when the process environment doesn't set one", () => {
    const result = loadEnv(["--env-file", samplePath], {});
    assert.equal(result.TECHNITIUM_API_TOKEN, "file-token");
  });

  it("an inline-commented value from the file is not masked by an empty process-env entry", () => {
    const result = loadEnv(["--env-file", samplePath], { QUX: "" });
    assert.equal(result.QUX, "300");
  });
});
