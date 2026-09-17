import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROMETHEUS_VERSION,
  RELEASE_SHA256,
  releaseAssetName,
  releasePlatformKey,
} from "../../../scripts/fetch-promtool.ts";

const SUPPORTED_RUNTIME_PLATFORMS: readonly [string, string][] = [
  ["win32", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
];

describe("releasePlatformKey", () => {
  it("maps win32/x64 to windows-amd64", () => {
    assert.equal(releasePlatformKey("win32", "x64"), "windows-amd64");
  });

  it("maps linux/x64 to linux-amd64", () => {
    assert.equal(releasePlatformKey("linux", "x64"), "linux-amd64");
  });

  it("passes darwin/arm64 through unchanged", () => {
    assert.equal(releasePlatformKey("darwin", "arm64"), "darwin-arm64");
  });
});

describe("releaseAssetName", () => {
  it("builds the exact upstream tarball name", () => {
    assert.equal(
      releaseAssetName("linux-amd64"),
      `prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz`,
    );
  });
});

describe("RELEASE_SHA256", () => {
  it("has a pinned digest for every platform Node.js actually reports at runtime", () => {
    for (const [platform, arch] of SUPPORTED_RUNTIME_PLATFORMS) {
      const key = releasePlatformKey(platform, arch);
      assert.ok(
        RELEASE_SHA256[key] !== undefined,
        `no pinned sha256 for ${platform}/${arch} -> "${key}"`,
      );
    }
  });
});
