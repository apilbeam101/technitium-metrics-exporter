import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

describe("TechnitiumHttpError", () => {
  it("carries the reason and message", () => {
    const error = new TechnitiumHttpError("timeout", "request timed out");
    assert.equal(error.reason, "timeout");
    assert.equal(error.message, "request timed out");
    assert.equal(error.name, "TechnitiumHttpError");
    assert.ok(error instanceof Error);
  });

  it("preserves a cause", () => {
    const cause = new Error("underlying failure");
    const error = new TechnitiumHttpError("network", "request failed", { cause });
    assert.equal(error.cause, cause);
  });
});
