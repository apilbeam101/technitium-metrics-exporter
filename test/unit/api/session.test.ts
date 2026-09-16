import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseSessionResponse } from "../../../src/api/session.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

const V15_CLUSTERED = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");
const PRE_V15 = readFileSync("test/fixtures/session/session-get-pre-v15.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");
const API_ERROR = readFileSync("test/fixtures/session/envelope-error.json", "utf8");

describe("parseSessionResponse", () => {
  it("parses version, domain and clusterInitialized from the flat envelope", () => {
    const info = parseSessionResponse(V15_CLUSTERED);
    assert.equal(info.version, "15.4");
    assert.equal(info.dnsServerDomain, "dns-a.example.com");
    assert.equal(info.clusterInitialized, true);
  });

  it("exposes the token's permission map keyed by section", () => {
    const info = parseSessionResponse(V15_CLUSTERED);
    assert.equal(info.permissions.Dashboard?.canView, true);
    assert.equal(info.permissions.Administration?.canView, false);
  });

  it("defaults clusterInitialized to false when the field is absent (pre-v15)", () => {
    const info = parseSessionResponse(PRE_V15);
    assert.equal(info.clusterInitialized, false);
  });

  it("leaves clusterPeers undefined when the target is not clustered", () => {
    const info = parseSessionResponse(PRE_V15);
    assert.equal(info.clusterPeers, undefined);
  });

  it("parses the peer inventory when clustered, discarding address and url", () => {
    const info = parseSessionResponse(V15_CLUSTERED);
    assert.ok(info.clusterPeers);
    assert.equal(info.clusterPeers?.length, 4);

    const peerB = info.clusterPeers?.find((p) => p.name === "dns-b.example.com");
    assert.ok(peerB);
    assert.equal(peerB?.type, "Secondary");
    assert.equal(peerB?.state, "Connected");
    assert.equal(peerB?.lastSeenSeconds, Date.parse("2026-09-15T07:59:30.000Z") / 1000);
    assert.equal((peerB as unknown as Record<string, unknown>).address, undefined);
    assert.equal((peerB as unknown as Record<string, unknown>).url, undefined);
  });

  it("reports lastSeenSeconds as undefined for the node's own entry", () => {
    const info = parseSessionResponse(V15_CLUSTERED);
    const self = info.clusterPeers?.find((p) => p.state === "Self");
    assert.ok(self);
    assert.equal(self?.lastSeenSeconds, undefined);
  });

  it("covers all four documented peer state values, including Unknown", () => {
    const info = parseSessionResponse(V15_CLUSTERED);
    const states = new Set(info.clusterPeers?.map((p) => p.state));
    assert.deepEqual(states, new Set(["Self", "Connected", "Unreachable", "Unknown"]));
  });

  it("throws a TechnitiumHttpError with reason auth on an invalid-token envelope", () => {
    assert.throws(
      () => parseSessionResponse(INVALID_TOKEN),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "auth",
    );
  });

  it("throws a TechnitiumHttpError with reason api_error on a status: error envelope", () => {
    assert.throws(
      () => parseSessionResponse(API_ERROR),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "api_error",
    );
  });

  it("throws a TechnitiumHttpError with reason parse on a non-JSON body", () => {
    assert.throws(
      () => parseSessionResponse("not json at all"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });

  it("throws a TechnitiumHttpError with reason parse when clusterInitialized is true but clusterNodes is absent", () => {
    const raw = JSON.parse(V15_CLUSTERED) as { info: Record<string, unknown> };
    delete raw.info.clusterNodes;

    assert.throws(
      () => parseSessionResponse(JSON.stringify(raw)),
      (error: unknown) =>
        error instanceof TechnitiumHttpError &&
        error.reason === "parse" &&
        error.message.includes("clusterNodes was absent"),
    );
  });
});
