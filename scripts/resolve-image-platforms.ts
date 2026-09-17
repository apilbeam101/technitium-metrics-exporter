import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type OCIManifestEntry = {
  digest: string;
  platform?: { os?: string; architecture?: string };
};

export type OCIImageIndex = { manifests: OCIManifestEntry[] };

export type PlatformDigest = { platform: string; digest: string };

// A multi-arch OCI index also lists non-image entries (buildx attestation
// referrers, provenance) tagged with platform "unknown/unknown" — those
// aren't a real platform to generate or attest a per-platform SBOM for.
export function resolvePlatformDigests(index: OCIImageIndex): PlatformDigest[] {
  return index.manifests
    .filter(
      (entry) => entry.platform?.os !== undefined && entry.platform.architecture !== "unknown",
    )
    .map((entry) => ({
      platform: `${entry.platform?.os}/${entry.platform?.architecture}`,
      digest: entry.digest,
    }));
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("usage: resolve-image-platforms.ts <manifest-index.json>");
    process.exit(2);
  }

  const index = JSON.parse(readFileSync(path, "utf8")) as OCIImageIndex;
  const platforms = resolvePlatformDigests(index);
  // A CI caller feeds this into a matrix strategy — an empty result makes
  // GitHub Actions silently skip that job rather than fail it, so nothing
  // would be attested and nothing would report the failure either.
  if (platforms.length === 0) {
    throw new Error(`no real platform entries found in ${path}`);
  }
  console.log(JSON.stringify(platforms));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
