import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePlatformDigests } from "../../../scripts/resolve-image-platforms.ts";

describe("resolvePlatformDigests", () => {
  it("extracts each real platform's digest", () => {
    const index = {
      manifests: [
        { digest: "sha256:amd64digest", platform: { os: "linux", architecture: "amd64" } },
        { digest: "sha256:arm64digest", platform: { os: "linux", architecture: "arm64" } },
      ],
    };
    assert.deepEqual(resolvePlatformDigests(index), [
      { platform: "linux/amd64", digest: "sha256:amd64digest" },
      { platform: "linux/arm64", digest: "sha256:arm64digest" },
    ]);
  });

  it("filters out unknown/unknown attestation-referrer entries", () => {
    const index = {
      manifests: [
        { digest: "sha256:amd64digest", platform: { os: "linux", architecture: "amd64" } },
        {
          digest: "sha256:attestationdigest",
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    };
    assert.deepEqual(resolvePlatformDigests(index), [
      { platform: "linux/amd64", digest: "sha256:amd64digest" },
    ]);
  });

  it("filters out an entry with no platform at all", () => {
    const index = {
      manifests: [{ digest: "sha256:nolayer" }],
    };
    assert.deepEqual(resolvePlatformDigests(index), []);
  });

  it("returns an empty array for an index with no manifest entries", () => {
    assert.deepEqual(resolvePlatformDigests({ manifests: [] }), []);
  });
});
