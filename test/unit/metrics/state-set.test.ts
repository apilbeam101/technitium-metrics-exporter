import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyStateSetValue } from "../../../src/metrics/state-set.ts";

const RECOGNIZED = ["Primary", "Secondary"] as const;

describe("classifyStateSetValue", () => {
  it("classifies undefined as absent", () => {
    assert.deepEqual(classifyStateSetValue(undefined, RECOGNIZED), { kind: "absent" });
  });

  it("classifies a value in the recognized set", () => {
    assert.deepEqual(classifyStateSetValue("Primary", RECOGNIZED), {
      kind: "recognized",
      value: "Primary",
    });
  });

  it("classifies a value outside the recognized set as unrecognized, without dropping it", () => {
    assert.deepEqual(classifyStateSetValue("Tertiary", RECOGNIZED), {
      kind: "unrecognized",
      value: "Tertiary",
    });
  });

  it("is case-sensitive: a differently-cased known value is unrecognized", () => {
    assert.deepEqual(classifyStateSetValue("primary", RECOGNIZED), {
      kind: "unrecognized",
      value: "primary",
    });
  });

  it("classifies an empty string as unrecognized rather than absent", () => {
    assert.deepEqual(classifyStateSetValue("", RECOGNIZED), { kind: "unrecognized", value: "" });
  });
});
