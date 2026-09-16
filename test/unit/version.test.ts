import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadBuildInfo } from "../../src/version.ts";

describe("loadBuildInfo", () => {
  it("reads the version from package.json", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    assert.equal(loadBuildInfo().version, packageJson.version);
  });

  it("falls back to 'unknown' when GIT_COMMIT is unset", () => {
    const previous = process.env.GIT_COMMIT;
    delete process.env.GIT_COMMIT;
    try {
      assert.equal(loadBuildInfo().commit, "unknown");
    } finally {
      if (previous !== undefined) process.env.GIT_COMMIT = previous;
    }
  });

  it("reads GIT_COMMIT when set", () => {
    const previous = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = "abc1234";
    try {
      assert.equal(loadBuildInfo().commit, "abc1234");
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMIT;
      else process.env.GIT_COMMIT = previous;
    }
  });

  it("reports the running Node.js version", () => {
    assert.equal(loadBuildInfo().nodeVersion, process.version);
  });
});
