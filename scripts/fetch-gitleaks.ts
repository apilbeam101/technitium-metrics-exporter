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

export const GITLEAKS_VERSION = "8.30.1";

// sha256 of each platform's release archive, recorded once from the real
// v8.30.1 release rather than re-derived from that release's own checksums
// file on every run (see verified-download.ts for why).
export const RELEASE_SHA256: Readonly<Record<string, string>> = {
  "linux-x64": "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  "linux-arm64": "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  "darwin-x64": "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  "darwin-arm64": "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  "windows-x64": "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
};

export function releasePlatformKey(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  return `${os}-${arch}`;
}

function archiveExtension(platformKey: string): string {
  return platformKey.startsWith("windows") ? "zip" : "tar.gz";
}

export function releaseAssetName(platformKey: string): string {
  return `gitleaks_${GITLEAKS_VERSION}_${platformKey.replace("-", "_")}.${archiveExtension(platformKey)}`;
}

export async function fetchGitleaks(
  destDir: string,
  platformKey = releasePlatformKey(process.platform, process.arch),
): Promise<string> {
  const expectedSha256 = RELEASE_SHA256[platformKey];
  if (expectedSha256 === undefined) {
    throw new Error(`no pinned gitleaks release for platform "${platformKey}"`);
  }

  const binaryName = platformKey.startsWith("windows") ? "gitleaks.exe" : "gitleaks";
  // Version-scoped subdirectory, not destDir directly: bumping
  // GITLEAKS_VERSION must not silently reuse a stale cached binary left over
  // from a previous version at the same plain path.
  const destBinary = join(destDir, GITLEAKS_VERSION, binaryName);
  if (existsSync(destBinary)) return destBinary;

  const assetName = releaseAssetName(platformKey);
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${assetName}`;
  const archive = await downloadVerified(url, expectedSha256);

  const scratchRoot = join(process.cwd(), ".local", "scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const extractDir = mkdtempSync(join(scratchRoot, "gitleaks-"));
  try {
    writeFileSync(join(extractDir, assetName), archive);
    // A relative filename with cwd set, not an absolute path: passing an
    // absolute Windows path (e.g. "C:\...") as tar's archive argument makes
    // it misparse the drive letter's colon as legacy "user@host:file" remote
    // syntax and fail with "Cannot connect to C: resolve failed".
    execFileSync(tarBinary(), ["xf", assetName], { cwd: extractDir });

    mkdirSync(join(destDir, GITLEAKS_VERSION), { recursive: true });
    cpSync(join(extractDir, binaryName), destBinary);
    if (!platformKey.startsWith("windows")) chmodSync(destBinary, 0o755);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }

  return destBinary;
}

async function main(): Promise<void> {
  const destDir = join(process.cwd(), ".local", "bin");
  const binaryPath = await fetchGitleaks(destDir);
  console.log(binaryPath);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
