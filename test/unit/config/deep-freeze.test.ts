import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deepFreeze } from "../../../src/config/deep-freeze.ts";

describe("deepFreeze", () => {
  it("freezes the top-level object", () => {
    const value = deepFreeze({ a: 1 });
    assert.ok(Object.isFrozen(value));
    assert.throws(() => {
      (value as { a: number }).a = 2;
    });
  });

  it("freezes nested objects", () => {
    const value = deepFreeze({ nested: { a: 1 } });
    assert.ok(Object.isFrozen(value.nested));
    assert.throws(() => {
      (value.nested as { a: number }).a = 2;
    });
  });

  it("freezes array elements", () => {
    const value = deepFreeze({ items: [{ a: 1 }, { a: 2 }] });
    assert.ok(Object.isFrozen(value.items));
    assert.ok(Object.isFrozen(value.items[0]));
    assert.throws(() => {
      value.items.push({ a: 3 });
    });
  });

  it("tolerates primitives and null", () => {
    assert.equal(deepFreeze(1), 1);
    assert.equal(deepFreeze("x"), "x");
    assert.equal(deepFreeze(null), null);
  });

  it("returns the same reference it was given", () => {
    const original = { a: 1 };
    assert.equal(deepFreeze(original), original);
  });

  it("still descends into a nested object when the root was already frozen shallowly", () => {
    const value = deepFreeze(Object.freeze({ nested: { a: 1 } }));
    assert.ok(Object.isFrozen(value.nested));
    assert.throws(() => {
      (value.nested as { a: number }).a = 2;
    });
  });

  it("tolerates a cyclic object graph without infinite recursion", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    assert.doesNotThrow(() => deepFreeze(value));
    assert.ok(Object.isFrozen(value));
  });
});
