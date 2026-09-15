import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { redactSummary } from "../../../src/config/redact-summary.ts";
import { validate } from "../../../src/config/validate.ts";

const DISTINCTIVE_TOKEN = "distinctive-super-secret-token-value";

function configWithToken() {
  const { config } = validate({
    TECHNITIUM_TARGETS: "dns-a=https://dns-a.example.com:53443",
    TECHNITIUM_API_TOKEN: DISTINCTIVE_TOKEN,
  });
  return config;
}

describe("redactSummary", () => {
  it("never contains the token under JSON.stringify", () => {
    const summary = redactSummary(configWithToken());
    assert.equal(JSON.stringify(summary).includes(DISTINCTIVE_TOKEN), false);
  });

  it("never contains the token under util.inspect", () => {
    const summary = redactSummary(configWithToken());
    assert.equal(inspect(summary, { depth: null }).includes(DISTINCTIVE_TOKEN), false);
  });

  it("still exposes non-secret target fields", () => {
    const summary = redactSummary(configWithToken()) as {
      targets: Array<{ name: string; baseUrl: string }>;
    };
    assert.equal(summary.targets[0]?.name, "dns-a");
    assert.equal(summary.targets[0]?.baseUrl, "https://dns-a.example.com:53443");
  });

  it("apiToken is an inert redacted string, not the live Secret — reveal() is unreachable", () => {
    const summary = redactSummary(configWithToken()) as { targets: Array<{ apiToken: unknown }> };
    const apiToken = summary.targets[0]?.apiToken;
    assert.equal(apiToken, "[REDACTED]");
    assert.equal(typeof (apiToken as { reveal?: unknown })?.reveal, "undefined");
  });
});
