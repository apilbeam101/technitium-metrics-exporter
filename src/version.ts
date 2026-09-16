import { readFileSync } from "node:fs";

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly nodeVersion: string;
}

interface PackageJson {
  readonly version: string;
}

// No build-time git-embedding step exists in this repo yet, so commit is
// read from an operator/CI-supplied env var with an honest fallback rather
// than inventing one here.
export function loadBuildInfo(): BuildInfo {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as PackageJson;

  return {
    version: packageJson.version,
    commit: process.env.GIT_COMMIT ?? "unknown",
    nodeVersion: process.version,
  };
}
