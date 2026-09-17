import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GITLEAKS_VERSION,
  RELEASE_SHA256,
  releaseAssetName,
  releasePlatformKey,
} from "../../../scripts/fetch-gitleaks.ts";

const SUPPORTED_RUNTIME_PLATFORMS: readonly [string, string][] = [
  ["win32", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
];

describe("releasePlatformKey", () => {
  it("maps win32 to windows", () => {
    assert.equal(releasePlatformKey("win32", "x64"), "windows-x64");
  });

  it("passes linux/x64 through unchanged", () => {
    assert.equal(releasePlatformKey("linux", "x64"), "linux-x64");
  });
});

describe("releaseAssetName", () => {
  it("builds a .tar.gz name for linux", () => {
    assert.equal(releaseAssetName("linux-x64"), `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`);
  });

  it("builds a .zip name for windows", () => {
    assert.equal(releaseAssetName("windows-x64"), `gitleaks_${GITLEAKS_VERSION}_windows_x64.zip`);
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
