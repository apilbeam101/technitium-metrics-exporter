import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_LICENSES,
  classifyLicenses,
  collectDependencyEntries,
} from "../../../scripts/check-license-compound.ts";

function verdictFor(license: string | undefined, allowlist?: readonly string[]) {
  return classifyLicenses([{ name: "pkg", license }], allowlist)[0];
}

describe("classifyLicenses", () => {
  it("allows a plain permissive license", () => {
    assert.equal(verdictFor("MIT")?.allowed, true);
  });

  it("disallows a plain copyleft license", () => {
    assert.equal(verdictFor("GPL-3.0")?.allowed, false);
  });

  it("disallows a missing license field", () => {
    assert.equal(verdictFor(undefined)?.allowed, false);
  });

  it("allows an OR expression when any term is permissive", () => {
    assert.equal(verdictFor("(GPL-2.0 OR MIT)")?.allowed, true);
  });

  it("disallows an OR expression when no term is permissive", () => {
    assert.equal(verdictFor("(GPL-2.0 OR AGPL-3.0)")?.allowed, false);
  });

  it("allows an AND expression only when every term is permissive", () => {
    assert.equal(verdictFor("(MIT AND CC0-1.0)")?.allowed, true);
    assert.equal(verdictFor("(MIT AND GPL-3.0)")?.allowed, false);
  });

  it("respects parenthesised grouping in a mixed AND/OR expression", () => {
    // The exact shape a naive strip-outer-parens implementation gets wrong:
    // (MIT OR GPL-2.0) AND GPL-3.0 must fail because of the trailing AND
    // term, not pass because MIT alone satisfies the OR.
    assert.equal(verdictFor("(MIT OR GPL-2.0) AND GPL-3.0")?.allowed, false);
    assert.equal(verdictFor("(MIT OR GPL-2.0) AND MIT")?.allowed, true);
  });

  it("respects grouping the other way round: AND group inside an OR", () => {
    assert.equal(verdictFor("GPL-3.0 OR (MIT AND ISC)")?.allowed, true);
    assert.equal(verdictFor("GPL-3.0 OR (MIT AND GPL-2.0)")?.allowed, false);
  });

  it("disallows a WITH exception even when the base license is permissive", () => {
    assert.equal(verdictFor("Apache-2.0 WITH LLVM-exception")?.allowed, false);
  });

  it("disallows lowercase operators as unparseable rather than misreading them", () => {
    assert.equal(verdictFor("MIT or Apache-2.0")?.allowed, false);
  });

  it("disallows a malformed expression instead of throwing", () => {
    assert.equal(verdictFor("(MIT OR")?.allowed, false);
    assert.equal(verdictFor("MIT))")?.allowed, false);
    assert.equal(verdictFor("")?.allowed, false);
  });

  it("sorts results by dependency name, then version", () => {
    const verdicts = classifyLicenses([
      { name: "zeta", license: "MIT" },
      { name: "alpha", version: "2.0.0", license: "MIT" },
      { name: "alpha", version: "1.0.0", license: "MIT" },
    ]);
    assert.deepEqual(
      verdicts.map((v) => `${v.name}@${v.version ?? ""}`),
      ["alpha@1.0.0", "alpha@2.0.0", "zeta@"],
    );
  });

  it("supports a custom allowlist", () => {
    assert.equal(verdictFor("MIT", ["Apache-2.0"])?.allowed, false);
  });

  it("exposes every default-allowlisted license", () => {
    for (const license of ALLOWED_LICENSES) {
      assert.equal(verdictFor(license)?.allowed, true, `expected ${license} to be allowed`);
    }
  });
});

describe("collectDependencyEntries", () => {
  it("resolves each tree position's own license rather than a global by-name lookup", () => {
    // The exact bug this guards against: the same package name installed at
    // two different tree positions with two different licenses (a nested,
    // non-hoisted dependency is the common real-world cause).
    const entries = collectDependencyEntries({
      dependencies: {
        top: {
          version: "1.0.0",
          path: "/root/node_modules/top",
          dependencies: {
            shared: {
              version: "1.0.0",
              license: "MIT",
              path: "/root/node_modules/shared",
            },
          },
        },
        nested: {
          version: "1.0.0",
          path: "/root/node_modules/nested",
          dependencies: {
            shared: {
              version: "2.0.0",
              license: "GPL-3.0-only",
              path: "/root/node_modules/nested/node_modules/shared",
            },
          },
        },
      },
    });

    const shared = entries.filter((e) => e.name === "shared");
    assert.equal(shared.length, 2);
    assert.ok(shared.some((e) => e.version === "1.0.0" && e.license === "MIT"));
    assert.ok(shared.some((e) => e.version === "2.0.0" && e.license === "GPL-3.0-only"));
  });

  it("normalizes the legacy { type, url } license object shape", () => {
    const [entry] = collectDependencyEntries({
      dependencies: { pkg: { version: "1.0.0", license: { type: "MIT", url: "https://x" } } },
    });
    assert.equal(entry?.license, "MIT");
  });

  it("treats a null license as missing rather than throwing", () => {
    const [entry] = collectDependencyEntries({
      dependencies: { pkg: { version: "1.0.0", license: null } },
    });
    assert.equal(entry?.license, undefined);
  });

  it("does not lose a dependency that has no path", () => {
    const entries = collectDependencyEntries({
      dependencies: { pkg: { version: "1.0.0", license: "MIT" } },
    });
    assert.equal(entries.length, 1);
  });

  it("does not recurse infinitely on a self-referential tree", () => {
    // npm's real tree cannot cycle, but this function is exported and
    // called directly against hand-built fixtures, which can — cycle
    // protection is the ancestor-path check, not the emitted-output set.
    type SelfReferentialFixture = {
      version: string;
      license: string;
      path: string;
      dependencies?: Record<string, SelfReferentialFixture>;
    };
    const cyclic: SelfReferentialFixture = {
      version: "1.0.0",
      license: "MIT",
      path: "/root/node_modules/a",
    };
    cyclic.dependencies = { a: cyclic };

    const entries = collectDependencyEntries({ dependencies: { a: cyclic } });
    assert.deepEqual(entries, [{ name: "a", version: "1.0.0", license: "MIT" }]);
  });

  it("still walks a shared package's children when reached via a childless occurrence first", () => {
    // The exact gap a naive "recurse only on first visit" fix leaves open:
    // if the same identity is first reached with no children, gating
    // recursion on the emitted-output set (rather than the ancestor path)
    // would silently drop this subtree instead of visiting it the second
    // time it's reached via a different, non-cyclic path.
    const entries = collectDependencyEntries({
      dependencies: {
        a: { path: "/a", dependencies: { shared: { path: "/shared", version: "1.0.0" } } },
        b: {
          path: "/b",
          dependencies: {
            shared: {
              path: "/shared",
              version: "1.0.0",
              dependencies: {
                onlyChild: { path: "/shared/only-child", version: "1.0.0", license: "0BSD" },
              },
            },
          },
        },
      },
    });

    assert.ok(entries.some((e) => e.name === "onlyChild" && e.license === "0BSD"));
  });
});
