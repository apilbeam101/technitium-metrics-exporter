import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

interface ZoneFixtureEntry {
  name: string;
  type: string;
  disabled: boolean;
  dnssecStatus: string;
  soaSerial: number;
  lastModified: string;
  internal?: boolean;
  expiry?: string;
  isExpired?: boolean;
  syncFailed?: boolean;
  notifyFailed?: boolean;
  notifyFailedFor?: string[];
}

const fixturePath = join(import.meta.dirname, "..", "..", "fixtures", "zones", "zones-list.json");

function loadZones(): ZoneFixtureEntry[] {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    response: { zones: ZoneFixtureEntry[] };
  };
  return fixture.response.zones;
}

const SEVEN_TYPES = [
  "Primary",
  "Secondary",
  "Stub",
  "Forwarder",
  "SecondaryForwarder",
  "Catalog",
  "SecondaryCatalog",
];

const SECONDARY_FAMILY = new Set(["Secondary", "SecondaryForwarder", "SecondaryCatalog"]);
const PRIMARY_FAMILY = new Set(["Primary", "Catalog"]);

describe("zones/list fixture", () => {
  it("spans all seven documented zone types", () => {
    const zones = loadZones();
    const types = new Set(zones.map((z) => z.type));
    for (const type of SEVEN_TYPES) {
      assert.ok(types.has(type), `missing zone type ${type}`);
    }
  });

  it("includes at least one internal zone with internal: true", () => {
    const zones = loadZones();
    const internalZones = zones.filter((z) => z.internal === true);
    assert.ok(internalZones.length >= 1);
  });

  it("sets internal: false explicitly on ordinary non-internal zones", () => {
    const zones = loadZones();
    const explicitlyNonInternal = zones.filter((z) => z.internal === false);
    assert.ok(explicitlyNonInternal.length > 0);
  });

  it("has at least one zone where the internal key is genuinely absent, preserving the absent-key hazard", () => {
    const zones = loadZones();
    const absentKeyZones = zones.filter((z) => !Object.hasOwn(z, "internal"));
    assert.ok(absentKeyZones.length >= 1, "no zone exercises the genuinely-absent internal key");
  });

  it("exposes expiry, isExpired and syncFailed only on secondary-family zones", () => {
    const zones = loadZones();
    for (const zone of zones) {
      const hasSecondaryFields =
        Object.hasOwn(zone, "expiry") ||
        Object.hasOwn(zone, "isExpired") ||
        Object.hasOwn(zone, "syncFailed");
      assert.equal(
        hasSecondaryFields,
        SECONDARY_FAMILY.has(zone.type),
        `${zone.name} (${zone.type}) has unexpected secondary-family field presence`,
      );
    }
  });

  // Neither DESIGN §3.2.7's primary-family (notify) nor secondary-family
  // (expiry/isExpired/syncFailed) conditional-field group documents Stub or
  // Forwarder, so this fixture deliberately gives them neither set.
  it("gives Stub and Forwarder zones neither the secondary-family nor primary-family conditional fields", () => {
    const zones = loadZones();
    for (const zone of zones.filter((z) => z.type === "Stub" || z.type === "Forwarder")) {
      assert.equal(Object.hasOwn(zone, "expiry"), false);
      assert.equal(Object.hasOwn(zone, "isExpired"), false);
      assert.equal(Object.hasOwn(zone, "syncFailed"), false);
      assert.equal(Object.hasOwn(zone, "notifyFailed"), false);
      assert.equal(Object.hasOwn(zone, "notifyFailedFor"), false);
    }
  });

  it("includes a secondary-family zone with isExpired/syncFailed present but expiry absent", () => {
    const zones = loadZones();
    const zone = zones.find(
      (z) =>
        SECONDARY_FAMILY.has(z.type) &&
        !Object.hasOwn(z, "expiry") &&
        Object.hasOwn(z, "isExpired") &&
        Object.hasOwn(z, "syncFailed"),
    );
    assert.ok(
      zone !== undefined,
      "missing a secondary-family zone exercising the absent-expiry-vs-zero-expiry hazard",
    );
  });

  it("gives every zone timestamp a trailing Z, per real ISO 8601 captures", () => {
    const zones = loadZones();
    for (const zone of zones) {
      assert.ok(zone.lastModified.endsWith("Z"), `${zone.name} lastModified missing Z suffix`);
      if (zone.expiry !== undefined) {
        assert.ok(zone.expiry.endsWith("Z"), `${zone.name} expiry missing Z suffix`);
      }
    }
  });

  it("exposes notifyFailed and notifyFailedFor only on non-internal primary-family zones", () => {
    const zones = loadZones();
    for (const zone of zones) {
      const hasNotifyFields =
        Object.hasOwn(zone, "notifyFailed") || Object.hasOwn(zone, "notifyFailedFor");
      const expected = PRIMARY_FAMILY.has(zone.type) && zone.internal !== true;
      assert.equal(
        hasNotifyFields,
        expected,
        `${zone.name} (${zone.type}, internal=${zone.internal ?? false}) has unexpected notify field presence`,
      );
    }
  });

  it("covers all three dnssecStatus values", () => {
    const zones = loadZones();
    const statuses = new Set(zones.map((z) => z.dnssecStatus));
    for (const status of ["Unsigned", "SignedWithNSEC", "SignedWithNSEC3"]) {
      assert.ok(statuses.has(status), `missing dnssecStatus ${status}`);
    }
  });

  it("has both a failed and a non-failed secondary sync example", () => {
    const zones = loadZones();
    const secondaries = zones.filter((z) => SECONDARY_FAMILY.has(z.type));
    assert.ok(secondaries.some((z) => z.syncFailed === true));
    assert.ok(secondaries.some((z) => z.syncFailed === false));
  });

  it("has both a failed and a non-failed primary notify example", () => {
    const zones = loadZones();
    const primaries = zones.filter((z) => PRIMARY_FAMILY.has(z.type) && z.internal !== true);
    assert.ok(primaries.some((z) => z.notifyFailed === true));
    assert.ok(primaries.some((z) => z.notifyFailed === false));
  });

  it("reports soaSerial for every zone, including Stub and Forwarder", () => {
    const zones = loadZones();
    for (const zone of zones) {
      assert.equal(typeof zone.soaSerial, "number");
    }
  });

  it("wraps zones in a response envelope alongside top-level server and status fields", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      response: { zones: ZoneFixtureEntry[] };
      server: string;
      status: string;
    };
    assert.equal(fixture.status, "ok");
    assert.equal(typeof fixture.server, "string");
    assert.ok(Array.isArray(fixture.response.zones));
  });
});

describe("zones/list empty fixture", () => {
  it("represents a token that can see zero zones, in the same envelope shape", () => {
    const emptyFixturePath = join(
      import.meta.dirname,
      "..",
      "..",
      "fixtures",
      "zones",
      "zones-list-empty.json",
    );
    const fixture = JSON.parse(readFileSync(emptyFixturePath, "utf8")) as {
      response: { zones: ZoneFixtureEntry[] };
      server: string;
      status: string;
    };
    assert.equal(fixture.status, "ok");
    assert.equal(typeof fixture.server, "string");
    assert.deepEqual(fixture.response.zones, []);
  });
});
