import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkNodeVersion } from "../../src/node-version-check.ts";

describe("checkNodeVersion", () => {
  it("does not exit for a supported version", () => {
    let exitCode: number | undefined;
    checkNodeVersion("v24.1.0", (code) => {
      exitCode = code;
    });
    assert.equal(exitCode, undefined);
  });

  it("does not exit for a newer major version", () => {
    let exitCode: number | undefined;
    checkNodeVersion("v25.0.0", (code) => {
      exitCode = code;
    });
    assert.equal(exitCode, undefined);
  });

  it("exits with a non-zero code for an unsupported version", () => {
    let exitCode: number | undefined;
    checkNodeVersion("v22.4.0", (code) => {
      exitCode = code;
    });
    assert.equal(exitCode, 1);
  });

  it("exits for an unparseable version string", () => {
    let exitCode: number | undefined;
    checkNodeVersion("garbage", (code) => {
      exitCode = code;
    });
    assert.equal(exitCode, 1);
  });
});
