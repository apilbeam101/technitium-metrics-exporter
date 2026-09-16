import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseZonesListResponse } from "../../../src/api/zones.ts";
import { isPrimaryFamily, isSecondaryFamily, ZONE_TYPES } from "../../../src/domain/zone.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

const ZONES_LIST = readFileSync("test/fixtures/zones/zones-list.json", "utf8");
const ZONES_LIST_EMPTY = readFileSync("test/fixtures/zones/zones-list-empty.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");
const API_ERROR = readFileSync("test/fixtures/session/envelope-error.json", "utf8");

describe("parseZonesListResponse", () => {
  it("parses all fourteen fixture zones", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    assert.equal(zones.length, 14);
  });

  it("returns an empty array for a token that can see zero zones", () => {
    const zones = parseZonesListResponse(ZONES_LIST_EMPTY);
    assert.deepEqual(zones, []);
  });

  it("leaves internal false for every ordinary, non-system zone", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    const example = zones.find((z) => z.name === "example.com");
    assert.equal(example?.internal, false);
  });

  it("marks the built-in system zones internal", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    const localhost = zones.find((z) => z.name === "localhost");
    assert.equal(localhost?.internal, true);
  });

  it("parses secondary-family expiry/isExpired/syncFailed and leaves them undefined on primary-family zones", () => {
    const zones = parseZonesListResponse(ZONES_LIST);

    const secondary = zones.find((z) => z.name === "secondary.example.com");
    assert.equal(secondary?.expirySeconds, Date.parse("2026-09-22T06:00:00.000Z") / 1000);
    assert.equal(secondary?.isExpired, false);
    assert.equal(secondary?.syncFailed, false);

    const primary = zones.find((z) => z.name === "example.com");
    assert.equal(primary?.expirySeconds, undefined);
    assert.equal(primary?.isExpired, undefined);
    assert.equal(primary?.syncFailed, undefined);
  });

  it("leaves expirySeconds undefined for a secondary zone reporting isExpired/syncFailed without expiry", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    const zone = zones.find((z) => z.name === "expiryless.example.com");
    assert.equal(zone?.expirySeconds, undefined);
    assert.equal(zone?.isExpired, true);
    assert.equal(zone?.syncFailed, false);
  });

  it("parses notifyFailed and reduces notifyFailedFor to a count on primary-family zones", () => {
    const zones = parseZonesListResponse(ZONES_LIST);

    const failing = zones.find((z) => z.name === "mail.example.com");
    assert.equal(failing?.notifyFailed, true);
    assert.equal(failing?.notifyFailedPeerCount, 2);

    const clean = zones.find((z) => z.name === "example.com");
    assert.equal(clean?.notifyFailed, false);
    assert.equal(clean?.notifyFailedPeerCount, 0);
  });

  it("leaves notifyFailed and notifyFailedPeerCount undefined on secondary-family, Stub and Forwarder zones", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    for (const name of ["secondary.example.com", "sub.example.com", "fwd.example.com"]) {
      const zone = zones.find((z) => z.name === name);
      assert.equal(zone?.notifyFailed, undefined, name);
      assert.equal(zone?.notifyFailedPeerCount, undefined, name);
    }
  });

  it("normalises lastModified through the shared .NET timestamp parser", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    const zone = zones.find((z) => z.name === "mail.example.com");
    assert.equal(zone?.lastModifiedSeconds, Date.parse("2026-09-11T09:30:00.765Z") / 1000);
  });

  it("throws a TechnitiumHttpError with reason auth on an invalid-token envelope", () => {
    assert.throws(
      () => parseZonesListResponse(INVALID_TOKEN),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "auth",
    );
  });

  it("throws a TechnitiumHttpError with reason api_error on a status: error envelope", () => {
    assert.throws(
      () => parseZonesListResponse(API_ERROR),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "api_error",
    );
  });

  it("throws a TechnitiumHttpError with reason parse on a non-JSON body", () => {
    assert.throws(
      () => parseZonesListResponse("not json at all"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });

  it("throws a TechnitiumHttpError with reason parse when response.zones is absent", () => {
    const raw = JSON.parse(ZONES_LIST) as { response: Record<string, unknown> };
    delete raw.response.zones;

    assert.throws(
      () => parseZonesListResponse(JSON.stringify(raw)),
      (error: unknown) =>
        error instanceof TechnitiumHttpError &&
        error.reason === "parse" &&
        error.message.includes("zones was missing"),
    );
  });

  it("tolerates a catalog field and other fields outside this design's metric surface (D§4.2)", () => {
    const envelope = {
      response: {
        zones: [
          {
            name: "member.example.com",
            type: "Secondary",
            disabled: false,
            dnssecStatus: "Unsigned",
            soaSerial: 1,
            lastModified: "2026-09-01T00:00:00.0000000Z",
            expiry: "2026-09-08T00:00:00.0000000Z",
            isExpired: false,
            syncFailed: false,
            catalog: "example.org",
            somethingFromAFutureApiVersion: true,
          },
        ],
      },
      server: "dns-a",
      status: "ok",
    };

    const zones = parseZonesListResponse(JSON.stringify(envelope));
    assert.equal(zones.length, 1);
    assert.equal(zones[0]?.name, "member.example.com");
    assert.equal((zones[0] as unknown as Record<string, unknown>).catalog, undefined);
  });

  it("reports conditional-field presence matching isSecondaryFamily/isPrimaryFamily for all seven zone types from the fixture", () => {
    const zones = parseZonesListResponse(ZONES_LIST);
    const byType = new Map(zones.filter((z) => !z.internal).map((z) => [z.type, z]));

    for (const type of ZONE_TYPES) {
      const zone = byType.get(type);
      assert.ok(zone, `fixture is missing a non-internal zone of type ${type}`);
      assert.equal(
        zone?.isExpired !== undefined || zone?.syncFailed !== undefined,
        isSecondaryFamily(type),
        `${type}: secondary-family field presence should match isSecondaryFamily`,
      );
      assert.equal(
        zone?.notifyFailed !== undefined,
        isPrimaryFamily(type),
        `${type}: notify field presence should match isPrimaryFamily`,
      );
    }
  });
});
