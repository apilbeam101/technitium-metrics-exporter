import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPrimaryFamily, isSecondaryFamily, ZONE_TYPES } from "../../../src/domain/zone.ts";

describe("isSecondaryFamily", () => {
  it("recognizes exactly the three secondary-family types", () => {
    const secondaryFamily = ZONE_TYPES.filter(isSecondaryFamily);
    assert.deepEqual(secondaryFamily, ["Secondary", "SecondaryForwarder", "SecondaryCatalog"]);
  });
});

describe("isPrimaryFamily", () => {
  it("recognizes exactly the two primary-family types", () => {
    const primaryFamily = ZONE_TYPES.filter(isPrimaryFamily);
    assert.deepEqual(primaryFamily, ["Primary", "Catalog"]);
  });
});

describe("Stub and Forwarder", () => {
  it("belong to neither family", () => {
    for (const type of ["Stub", "Forwarder"]) {
      assert.equal(isSecondaryFamily(type), false, type);
      assert.equal(isPrimaryFamily(type), false, type);
    }
  });
});
