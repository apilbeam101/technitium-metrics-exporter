import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tarBinary } from "./tar-binary.ts";
import { downloadVerified } from "./verified-download.ts";

export const PROMETHEUS_VERSION = "3.14.0";

// sha256 of each platform's release tarball, recorded once from the real
// v3.14.0 release rather than re-derived from that release's own
// sha256sums.txt on every run (see verified-download.ts for why).
export const RELEASE_SHA256: Readonly<Record<string, string>> = {
  "linux-amd64": "f665c6da19eb7ba399c915d30c7d9793c9b417bf8a749b504bc470678631478d",
  "linux-arm64": "077f3781ab7245dc04c9a3c9b78ba120fc8e41aa0dc97489b0af67247e50ba83",
  "darwin-amd64": "a14307b9726e66cadb81be9a544732623af26dabeb7702c987aa9c3c062ada34",
  "darwin-arm64": "a9623f7f4fe65b1b171b423c1a72bbf23dfdf41a171dcb33e7dd302af80dc01c",
  "windows-amd64": "272bcdd15d9327c7b1e08fe916ea48633819f82f2ea0bf354e6b8c0350c156ba",
};

export function releasePlatformKey(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  const normalizedArch = arch === "x64" ? "amd64" : arch;
  return `${os}-${normalizedArch}`;
}

export function releaseAssetName(platformKey: string): string {
  return `prometheus-${PROMETHEUS_VERSION}.${platformKey}.tar.gz`;
}

export async function fetchPromtool(
  destDir: string,
  platformKey = releasePlatformKey(process.platform, process.arch),
): Promise<string> {
  const expectedSha256 = RELEASE_SHA256[platformKey];
  if (expectedSha256 === undefined) {
    throw new Error(`no pinned promtool release for platform "${platformKey}"`);
  }

  const binaryName = platformKey.startsWith("windows") ? "promtool.exe" : "promtool";
  // Version-scoped subdirectory, not destDir directly: bumping
  // PROMETHEUS_VERSION must not silently reuse a stale cached binary left
  // over from a previous version at the same plain path.
  const destBinary = join(destDir, PROMETHEUS_VERSION, binaryName);
  if (existsSync(destBinary)) return destBinary;

  const assetName = releaseAssetName(platformKey);
  const url = `https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/${assetName}`;
  const archive = await downloadVerified(url, expectedSha256);

  const scratchRoot = join(process.cwd(), ".local", "scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const extractDir = mkdtempSync(join(scratchRoot, "promtool-"));
  try {
    writeFileSync(join(extractDir, assetName), archive);
    // A relative filename with cwd set, not an absolute path: passing an
    // absolute Windows path (e.g. "C:\...") as tar's archive argument makes
    // it misparse the drive letter's colon as legacy "user@host:file" remote
    // syntax and fail with "Cannot connect to C: resolve failed".
    execFileSync(tarBinary(), ["xf", assetName], { cwd: extractDir });

    mkdirSync(join(destDir, PROMETHEUS_VERSION), { recursive: true });
    const extractedBinary = join(
      extractDir,
      `prometheus-${PROMETHEUS_VERSION}.${platformKey}`,
      binaryName,
    );
    cpSync(extractedBinary, destBinary);
    if (!platformKey.startsWith("windows")) chmodSync(destBinary, 0o755);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }

  return destBinary;
}

async function main(): Promise<void> {
  const destDir = join(process.cwd(), ".local", "bin");
  const binaryPath = await fetchPromtool(destDir);
  console.log(binaryPath);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
