import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDotNetTimestamp } from "../../../src/api/time.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

describe("parseDotNetTimestamp", () => {
  it("maps the documented bare never-sentinel to undefined", () => {
    assert.equal(parseDotNetTimestamp("0001-01-01T00:00:00"), undefined);
  });

  it("maps every real sentinel dressing to undefined, not a year-1 timestamp", () => {
    for (const sentinel of [
      "0001-01-01T00:00:00.0000000",
      "0001-01-01T00:00:00Z",
      "0001-01-01T00:00:00.0000000Z",
    ]) {
      assert.equal(parseDotNetTimestamp(sentinel), undefined, sentinel);
    }
  });

  it("parses a Z-suffixed timestamp with seven fractional digits", () => {
    const seconds = parseDotNetTimestamp("2026-09-15T07:59:30.0000000Z");
    assert.equal(seconds, Date.parse("2026-09-15T07:59:30.000Z") / 1000);
  });

  it("truncates fractional digits beyond millisecond precision without rounding", () => {
    const seconds = parseDotNetTimestamp("2026-09-15T07:59:30.1239999Z");
    assert.equal(seconds, Date.parse("2026-09-15T07:59:30.123Z") / 1000);
  });

  it("interprets a suffix-less timestamp as UTC regardless of the host TZ", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const seconds = parseDotNetTimestamp("2026-09-15T08:00:00");
      assert.equal(seconds, Date.parse("2026-09-15T08:00:00Z") / 1000);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("accepts a numeric-offset timezone suffix without appending Z", () => {
    const seconds = parseDotNetTimestamp("2026-09-15T08:00:00+02:00");
    assert.equal(seconds, Date.parse("2026-09-15T08:00:00+02:00") / 1000);
  });

  it("throws a TechnitiumHttpError with reason parse on an unparseable value", () => {
    assert.throws(
      () => parseDotNetTimestamp("not-a-timestamp"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });
});
