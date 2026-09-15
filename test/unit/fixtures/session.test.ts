import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures", "session");

interface SessionFixture {
  username: string;
  token: string;
  info: {
    version: string;
    clusterInitialized?: boolean;
    permissions: Record<string, { canView: boolean; canModify: boolean; canDelete: boolean }>;
  };
  server: string;
  status: string;
}

const ALL_SESSION_FIXTURES = ["session-get-v15.json", "session-get-pre-v15.json"];

// Pre-v15 fixtures must not carry clusterInitialized: clustering (like both
// metrics endpoints and Bearer auth) was introduced at v15.0 (D§3.4), so a
// genuinely pre-v15 server could never report it.
const PRE_V15_SESSION_FIXTURES = ["session-get-pre-v15.json"];

function readJson(name: string): SessionFixture {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as SessionFixture;
}

describe("session/get fixtures", () => {
  it("is a flat envelope, with no response wrapper", () => {
    for (const name of ALL_SESSION_FIXTURES) {
      const fixture = readJson(name) as unknown as Record<string, unknown>;
      assert.equal(Object.hasOwn(fixture, "response"), false);
      assert.equal(Object.hasOwn(fixture, "info"), true);
    }
  });

  it("v15+ fixture reports a version at or above the minimum supported server version", () => {
    const fixture = readJson("session-get-v15.json");
    const [major] = fixture.info.version.split(".").map(Number);
    assert.ok(major !== undefined && major >= 15);
  });

  it("pre-v15 fixture reports a version clearly below the minimum supported server version", () => {
    const fixture = readJson("session-get-pre-v15.json");
    const [major] = fixture.info.version.split(".").map(Number);
    assert.ok(major !== undefined && major < 15);
  });

  it("pre-v15 fixtures do not report clusterInitialized, a v15.0 clustering feature", () => {
    for (const name of PRE_V15_SESSION_FIXTURES) {
      const fixture = readJson(name);
      assert.equal(
        Object.hasOwn(fixture.info, "clusterInitialized"),
        false,
        `${name} reports clusterInitialized`,
      );
    }
  });

  it("all session fixtures expose the documented permission sections, keyed by section name", () => {
    const documentedSections = [
      "Dashboard",
      "Zones",
      "Cache",
      "Allowed",
      "Blocked",
      "Apps",
      "DnsClient",
      "DhcpServer",
      "Logs",
      "Administration",
      "Settings",
    ];

    for (const name of ALL_SESSION_FIXTURES) {
      const fixture = readJson(name);
      for (const section of documentedSections) {
        assert.ok(
          Object.hasOwn(fixture.info.permissions, section),
          `${name} missing permission section ${section}`,
        );
      }
    }
  });

  it("does not use a token-shaped placeholder for the echoed session token", () => {
    for (const name of ALL_SESSION_FIXTURES) {
      const fixture = readJson(name);
      assert.equal(/^[A-Za-z0-9+/]{32,}$/.test(fixture.token), false);
    }
  });
});

describe("envelope fixtures", () => {
  it("invalid-token envelope carries only the status field", () => {
    const fixture = JSON.parse(
      readFileSync(join(fixturesDir, "envelope-invalid-token.json"), "utf8"),
    ) as { status: string };
    assert.equal(fixture.status, "invalid-token");
  });

  it("error envelope carries errorMessage and stackTrace", () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, "envelope-error.json"), "utf8")) as {
      status: string;
      errorMessage: string;
      stackTrace: string;
    };
    assert.equal(fixture.status, "error");
    assert.ok(fixture.errorMessage.length > 0);
    assert.ok(fixture.stackTrace.length > 0);
  });
});
