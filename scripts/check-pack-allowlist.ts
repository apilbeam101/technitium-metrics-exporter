import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Files npm always includes regardless of the "files" field, plus this
// package's own declared "files" allowlist. Anything else slipping into the
// tarball means something (commonly a nested directory npm's own defaults
// don't exclude) bypassed the intended allowlist.
export const ALLOWED_PACK_PATTERNS: readonly RegExp[] = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\//,
];

// The allowlist above only ever shrinks the tarball, so on its own it cannot
// catch the opposite failure: a build that silently produced an empty or
// wrong dist/, which would still pass with zero violations. Unlike the
// allowlist, these are exact expected paths, not patterns, so a plain string
// list stays both correct and directly readable in an error message.
export const REQUIRED_PACK_ENTRIES: readonly string[] = ["dist/index.js"];

export function findPackViolations(
  paths: readonly string[],
  allowlist: readonly RegExp[] = ALLOWED_PACK_PATTERNS,
): string[] {
  return paths.filter((path) => !allowlist.some((pattern) => pattern.test(path)));
}

export function findMissingRequiredEntries(
  paths: readonly string[],
  required: readonly string[] = REQUIRED_PACK_ENTRIES,
): string[] {
  return required.filter((requiredPath) => !paths.includes(requiredPath));
}

interface NpmPackEntry {
  files: { path: string }[];
}

export function getPackedPaths(): string[] {
  // execSync always goes through a shell, which is what lets this run
  // unmodified on both POSIX (/bin/sh) and Windows (cmd.exe, where npm is a
  // .cmd shim rather than a directly executable binary). The command is a
  // fixed literal with no untrusted interpolation.
  const output = execSync("npm pack --dry-run --json", {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(output) as NpmPackEntry[];
  const entry = parsed[0];
  if (entry === undefined || !Array.isArray(entry.files)) {
    throw new Error("npm pack --dry-run --json returned an unexpected shape");
  }
  return entry.files.map((file) => file.path);
}

function main(): void {
  const paths = getPackedPaths();
  const violations = findPackViolations(paths);
  const missing = findMissingRequiredEntries(paths);

  if (violations.length > 0) {
    console.error("Files outside the pack allowlist would be published:");
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
  }

  if (missing.length > 0) {
    console.error("Required files are missing from the tarball:");
    for (const requiredPath of missing) {
      console.error(`  ${requiredPath}`);
    }
  }

  if (violations.length > 0 || missing.length > 0) {
    process.exit(1);
  }

  console.log(`Pack contents match the allowlist (${paths.length} file(s)).`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
