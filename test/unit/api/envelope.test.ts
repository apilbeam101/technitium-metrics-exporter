import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertOk, classifyEnvelope } from "../../../src/api/envelope.ts";
import { TechnitiumHttpError } from "../../../src/http/errors.ts";

const INVALID_TOKEN_FIXTURE = readFileSync(
  "test/fixtures/session/envelope-invalid-token.json",
  "utf8",
);
const API_ERROR_FIXTURE = readFileSync("test/fixtures/session/envelope-error.json", "utf8");

describe("classifyEnvelope", () => {
  it("classifies a 200 response carrying invalid-token as an auth failure", () => {
    const classification = classifyEnvelope(INVALID_TOKEN_FIXTURE, "wrapped");
    assert.deepEqual(classification, { kind: "invalid-token" });
  });

  it("classifies a status: error envelope, including its stack trace", () => {
    const classification = classifyEnvelope(API_ERROR_FIXTURE, "wrapped");
    assert.equal(classification.kind, "api-error");
    if (classification.kind !== "api-error") return;
    assert.equal(
      classification.errorMessage,
      "Example error condition encountered while processing the request",
    );
    assert.match(classification.stackTrace ?? "", /ExampleHandler/);
  });

  it("classifies a wrapped status: ok envelope, exposing only its response field (zones/list, stats/get, cluster/state shape)", () => {
    const classification = classifyEnvelope<{ version: string }>(
      JSON.stringify({ status: "ok", response: { version: "15.4" } }),
      "wrapped",
    );
    assert.deepEqual(classification, { kind: "ok", response: { version: "15.4" } });
  });

  it("classifies a wrapped envelope with no response key as not-json, rather than inferring it is flat", () => {
    const classification = classifyEnvelope(
      JSON.stringify({ status: "ok", server: "dns-a" }),
      "wrapped",
    );
    assert.deepEqual(classification, { kind: "not-json" });
  });

  it("classifies a flat status: ok envelope, exposing the whole envelope (session/get's own shape)", () => {
    const sessionFixture = readFileSync("test/fixtures/session/session-get-v15.json", "utf8");
    const classification = classifyEnvelope<{ info: { version: string } }>(sessionFixture, "flat");
    assert.equal(classification.kind, "ok");
    if (classification.kind !== "ok") return;
    assert.equal(classification.response.info.version, "15.4");
  });

  it("classifies non-JSON bodies (e.g. Prometheus text) as not-json", () => {
    const classification = classifyEnvelope(
      "# HELP queries_total total queries\nqueries_total 42\n",
      "wrapped",
    );
    assert.deepEqual(classification, { kind: "not-json" });
  });

  it("classifies an empty body as not-json", () => {
    assert.deepEqual(classifyEnvelope("", "wrapped"), { kind: "not-json" });
  });

  it("classifies JSON with no recognized status field as not-json", () => {
    const classification = classifyEnvelope(JSON.stringify({ foo: "bar" }), "wrapped");
    assert.deepEqual(classification, { kind: "not-json" });
  });

  it("classifies a JSON array or primitive as not-json", () => {
    assert.deepEqual(classifyEnvelope("[1,2,3]", "wrapped"), { kind: "not-json" });
    assert.deepEqual(classifyEnvelope("42", "wrapped"), { kind: "not-json" });
    assert.deepEqual(classifyEnvelope("null", "wrapped"), { kind: "not-json" });
  });

  it("falls back to an empty errorMessage and an undefined stackTrace when either is not a string", () => {
    const classification = classifyEnvelope(JSON.stringify({ status: "error" }), "wrapped");
    assert.deepEqual(classification, {
      kind: "api-error",
      errorMessage: "",
      stackTrace: undefined,
    });
  });
});

describe("assertOk", () => {
  it("returns the response on ok", () => {
    const result = assertOk({ kind: "ok", response: { version: "15.4" } }, "session/get");
    assert.deepEqual(result, { version: "15.4" });
  });

  it("throws a TechnitiumHttpError with reason auth for invalid-token", () => {
    assert.throws(
      () => assertOk(classifyEnvelope(INVALID_TOKEN_FIXTURE, "wrapped"), "session/get"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "auth",
    );
  });

  it("throws a TechnitiumHttpError with reason api_error for status: error", () => {
    assert.throws(
      () => assertOk(classifyEnvelope(API_ERROR_FIXTURE, "wrapped"), "session/get"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "api_error",
    );
  });

  it("throws a TechnitiumHttpError with reason parse for not-json", () => {
    assert.throws(
      () => assertOk(classifyEnvelope("not json at all", "wrapped"), "session/get"),
      (error: unknown) => error instanceof TechnitiumHttpError && error.reason === "parse",
    );
  });
});
