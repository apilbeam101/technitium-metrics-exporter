import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { Secret } from "../../../src/config/secret.ts";

describe("Secret", () => {
  it("reveals the original value only through reveal()", () => {
    const secret = new Secret("super-secret-value");
    assert.equal(secret.reveal(), "super-secret-value");
  });

  it("redacts on string coercion", () => {
    const secret = new Secret("super-secret-value");
    assert.equal(String(secret), "[REDACTED]");
    assert.equal(`${secret}`, "[REDACTED]");
  });

  it("redacts under JSON.stringify, including when nested", () => {
    const secret = new Secret("super-secret-value");
    assert.equal(JSON.stringify(secret), '"[REDACTED]"');
    assert.equal(JSON.stringify({ token: secret }).includes("super-secret-value"), false);
    assert.match(JSON.stringify({ token: secret }), /\[REDACTED\]/);
  });

  it("redacts under util.inspect, including when nested", () => {
    const secret = new Secret("super-secret-value");
    assert.equal(inspect(secret).includes("super-secret-value"), false);
    assert.match(inspect(secret), /\[REDACTED\]/);
    assert.equal(inspect({ token: secret }).includes("super-secret-value"), false);
  });
});
