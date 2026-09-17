import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractChangelogSection } from "../../../scripts/extract-changelog-section.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- something new

## [1.2.0] - 2026-01-15

### Added

- first stable feature

### Fixed

- a bug

## [1.1.0] - 2025-12-01

### Added

- initial release
`;

describe("extractChangelogSection", () => {
  it("extracts a middle section up to the next heading", () => {
    const section = extractChangelogSection(CHANGELOG, "1.2.0");
    assert.match(section ?? "", /^## \[1\.2\.0\] - 2026-01-15/);
    assert.match(section ?? "", /first stable feature/);
    assert.doesNotMatch(section ?? "", /initial release/);
  });

  it("extracts the last section through end of file", () => {
    const section = extractChangelogSection(CHANGELOG, "1.1.0");
    assert.match(section ?? "", /initial release/);
  });

  it("returns undefined for a version with no section", () => {
    assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), undefined);
  });

  it("does not partially match a version that is a prefix of another", () => {
    assert.equal(extractChangelogSection(CHANGELOG, "1.2"), undefined);
  });

  it("extracts through end of file when the target is the only release section (first tag)", () => {
    const firstTagChangelog = `# Changelog

## [Unreleased]

### Added

- something new

## [0.1.0] - 2026-01-01

### Added

- first release
`;
    const section = extractChangelogSection(firstTagChangelog, "0.1.0");
    assert.match(section ?? "", /^## \[0\.1\.0\] - 2026-01-01/);
    assert.match(section ?? "", /first release/);
  });
});
