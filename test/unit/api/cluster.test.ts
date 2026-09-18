import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseClusterStateResponse } from "../../../src/api/cluster.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

const CLUSTER_STATE = readFileSync("test/fixtures/cluster/cluster-state.json", "utf8");
const INVALID_TOKEN = readFileSync("test/fixtures/session/envelope-invalid-token.json", "utf8");
const API_ERROR = readFileSync("test/fixtures/session/envelope-error.json", "utf8");

describe("parseClusterStateResponse", () => {
  it("parses the three interval fields under their real seconds-suffixed names", () => {
    const detail = parseClusterStateResponse(CLUSTER_STATE);
    assert.equal(detail.heartbeatRefreshIntervalSeconds, 30);
    assert.equal(detail.heartbeatRetryIntervalSeconds, 10);
    assert.equal(detail.configRefreshIntervalSeconds, 900);
  });

  it("normalises configLastSynced through the shared .NET timestamp parser", () => {
    const detail = parseClusterStateResponse(CLUSTER_STATE);
    assert.equal(detail.configLastSyncedSeconds, Date.parse("2026-09-15T08:00:00Z") / 1000);
  });

  // Exercises parseDotNetTimestamp's defensive sentinel handling on this
  // field; no live capture has confirmed configLastSynced ever actually
  // carries the sentinel (D§3.2.10's documented case is clusterNodes[].lastSeen,
  // which this parser doesn't read at all — see api/cluster.ts). A live
  // capture has confirmed configLastSynced can be genuinely absent instead
  // (see the next test and D§9.3).
  it("maps a never-sentinel configLastSynced to undefined", () => {
    const raw = JSON.parse(CLUSTER_STATE) as { response: Record<string, unknown> };
    raw.response.configLastSynced = "0001-01-01T00:00:00";

    const detail = parseClusterStateResponse(JSON.stringify(raw));
    assert.equal(detail.configLastSyncedSeconds, undefined);
  });

  it("leaves every field undefined when the response omits it entirely", () => {
    const raw = JSON.parse(CLUSTER_STATE) as { response: Record<string, unknown> };
    delete raw.response.heartbeatRefreshIntervalSeconds;
    delete raw.response.heartbeatRetryIntervalSeconds;
    delete raw.response.configRefreshIntervalSeconds;
    delete raw.response.configLastSynced;

    const detail = parseClusterStateResponse(JSON.stringify(raw));
    assert.equal(detail.heartbeatRefreshIntervalSeconds, undefined);
    assert.equal(detail.heartbeatRetryIntervalSeconds, undefined);
    assert.equal(detail.configRefreshIntervalSeconds, undefined);
    assert.equal(detail.configLastSyncedSeconds, undefined);
  });

  it("ignores fields outside this design's four-metric surface that the real fixture actually carries, including the peer inventory and its addresses", () => {
    const detail = parseClusterStateResponse(CLUSTER_STATE) as unknown as Record<string, unknown>;
    assert.equal(detail.clusterNodes, undefined);
    assert.equal(detail.clusterInitialized, undefined);
    assert.equal(detail.dnsServerDomain, undefined);
    assert.equal(detail.version, undefined);
    assert.equal(detail.clusterDomain, undefined);
  });

  // configRetryIntervalSeconds is confirmed present in a live capture (unlike
  // when this test was first written against the published API docs alone),
  // and the real fixture now carries it too — so this reads it directly
  // rather than constructing a synthetic envelope.
  it("tolerates configRetryIntervalSeconds without exporting it, confirmed present in a live capture", () => {
    const detail = parseClusterStateResponse(CLUSTER_STATE) as unknown as Record<string, unknown>;
    assert.equal(detail.configRetryIntervalSeconds, undefined);
  });

  // serverIpAddresses is never requested (includeServerIpAddresses isn't
  // passed) so it never arrives in a real capture either — this constructs a
  // synthetic envelope instead, otherwise the assertion would hold regardless
  // of whether the parser actually ignores the field or simply never saw it.
  it("tolerates serverIpAddresses without exporting it, per the published (unconfirmed-live) API docs shape", () => {
    const raw = JSON.parse(CLUSTER_STATE) as { response: Record<string, unknown> };
    raw.response.serverIpAddresses = ["192.0.2.5"];

    const detail = parseClusterStateResponse(JSON.stringify(raw)) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(detail.serverIpAddresses, undefined);
  });

  it("throws a TechnitiumHttpError with reason auth on an invalid-token envelope", () => {
    assert.throws(
      () => parseClusterStateResponse(INVALID_TOKEN),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "auth",
    );
  });

  it("throws a TechnitiumHttpError with reason api_error on a status: error envelope", () => {
    assert.throws(
      () => parseClusterStateResponse(API_ERROR),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "api_error",
    );
  });

  it("throws a TechnitiumHttpError with reason parse on a non-JSON body", () => {
    assert.throws(
      () => parseClusterStateResponse("not json at all"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });
});
