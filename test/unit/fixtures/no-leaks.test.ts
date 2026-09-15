import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkPaths } from "../../../scripts/sanitize-fixtures.ts";

describe("committed fixtures", () => {
  it("contain no routable IP address, real domain, or token-shaped string", () => {
    const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
    const results = checkPaths([fixturesDir]);

    if (results.length > 0) {
      const detail = results
        .flatMap(({ file, leaks }) => leaks.map((l) => `${file}: [${l.kind}] ${l.value}`))
        .join("\n");
      assert.fail(`sensitive content found in committed fixtures:\n${detail}`);
    }
  });
});
