import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_PACK_PATTERNS,
  findMissingRequiredEntries,
  findPackViolations,
  getPackedPaths,
  REQUIRED_PACK_ENTRIES,
} from "../../../scripts/check-pack-allowlist.ts";

describe("findPackViolations", () => {
  it("allows package.json, README.md, LICENSE and anything under dist/", () => {
    const paths = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/nested/foo.js"];

    assert.deepEqual(findPackViolations(paths), []);
  });

  it("flags a file outside the allowlist", () => {
    const paths = ["package.json", ".env", "src/secret.ts"];

    assert.deepEqual(findPackViolations(paths), [".env", "src/secret.ts"]);
  });

  it("flags a docs directory that has not been explicitly allowed", () => {
    // Guards against the exact .dockerignore-style hazard this check exists
    // for: a nested directory that npm's own defaults do not exclude.
    assert.deepEqual(findPackViolations(["docs/DESIGN.md"]), ["docs/DESIGN.md"]);
  });

  it("uses ALLOWED_PACK_PATTERNS as the default allowlist", () => {
    assert.deepEqual(findPackViolations(["package.json"]), []);
    assert.deepEqual(
      findPackViolations(["package.json"], ALLOWED_PACK_PATTERNS),
      findPackViolations(["package.json"]),
    );
  });

  it("supports a narrower allowlist for testing", () => {
    assert.deepEqual(findPackViolations(["README.md"], [/^LICENSE$/]), ["README.md"]);
  });
});

describe("findMissingRequiredEntries", () => {
  it("reports nothing missing when the entry point is present", () => {
    assert.deepEqual(findMissingRequiredEntries(["package.json", "dist/index.js"]), []);
  });

  it("catches a tarball with an allowlist-satisfying but empty dist/", () => {
    // The exact one-directional gap this function exists to close: a build
    // that emitted nothing still passes an allowlist check with zero
    // violations, since an allowlist can only ever reject extra files.
    assert.deepEqual(findMissingRequiredEntries(["package.json", "README.md", "LICENSE"]), [
      "dist/index.js",
    ]);
  });

  it("uses REQUIRED_PACK_ENTRIES as the default", () => {
    assert.deepEqual(
      findMissingRequiredEntries(["dist/index.js"]),
      findMissingRequiredEntries(["dist/index.js"], REQUIRED_PACK_ENTRIES),
    );
  });

  it("supports a custom required set for testing", () => {
    assert.deepEqual(findMissingRequiredEntries(["dist/index.js"], ["dist/cli.js"]), [
      "dist/cli.js",
    ]);
  });
});

describe("getPackedPaths", () => {
  it("shells out to the real npm binary and returns package.json at minimum", () => {
    // npm always includes package.json regardless of the "files" field, so
    // this is the one path guaranteed present without depending on dist/
    // having been built first — it exercises the actual npm-shelling code
    // path (JSON parsing, shape assumptions) against the real npm on PATH
    // rather than only the pure functions above.
    const paths = getPackedPaths();
    assert.ok(Array.isArray(paths));
    assert.ok(paths.includes("package.json"));
  });
});
