import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Permissive licenses only. Copyleft (GPL/AGPL/LGPL family) and
// no-license/unlicensed packages are never allowed in the production
// dependency tree of an Apache-2.0 project.
export const ALLOWED_LICENSES: readonly string[] = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
];

export type LicenseEntry = { name: string; version?: string; license: string | undefined };
export type LicenseVerdict = LicenseEntry & { allowed: boolean };

// A minimal tokenizing recursive-descent evaluator for the subset of the SPDX
// license-expression grammar actually seen in package.json "license" fields:
// identifiers, parenthesised groups, and AND/OR (case-sensitive, per the SPDX
// spec). AND binds tighter than OR, matching SPDX precedence. "WITH" license
// exceptions and any other malformed or unsupported input are deliberately
// treated as not allowed — a human needs to look at those, not this script.
function tokenize(expr: string): string[] {
  return expr
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function isLicenseAllowed(licenseExpr: string, allowlist: readonly string[]): boolean {
  const tokens = tokenize(licenseExpr);
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const consume = (): string => {
    const token = tokens[pos];
    if (token === undefined) throw new Error("unexpected end of license expression");
    pos += 1;
    return token;
  };

  function parseAtom(): boolean {
    const token = consume();

    if (token === "(") {
      const result = parseOr();
      if (consume() !== ")") throw new Error("expected closing parenthesis");
      return result;
    }
    if (token === "AND" || token === "OR" || token === ")") {
      throw new Error(`unexpected token: ${token}`);
    }
    if (peek() === "WITH") {
      consume();
      consume(); // the exception identifier; exceptions are out of scope and fail closed
      return false;
    }
    return allowlist.includes(token);
  }

  function parseAnd(): boolean {
    let result = parseAtom();
    while (peek() === "AND") {
      consume();
      result = parseAtom() && result;
    }
    return result;
  }

  function parseOr(): boolean {
    let result = parseAnd();
    while (peek() === "OR") {
      consume();
      result = parseAnd() || result;
    }
    return result;
  }

  try {
    const result = parseOr();
    if (pos !== tokens.length) throw new Error("trailing tokens in license expression");
    return result;
  } catch {
    return false;
  }
}

export function classifyLicenses(
  entries: readonly LicenseEntry[],
  allowlist: readonly string[] = ALLOWED_LICENSES,
): LicenseVerdict[] {
  return entries
    .map((entry) => ({
      ...entry,
      allowed: entry.license !== undefined && isLicenseAllowed(entry.license, allowlist),
    }))
    .sort(
      (a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? ""),
    );
}

// npm's legacy license object shape, e.g. { "type": "MIT", "url": "..." },
// is still seen in the wild alongside the modern plain SPDX string.
type NpmLicenseField = string | { type?: string; url?: string } | null | undefined;

interface NpmLsDependency {
  version?: string;
  license?: NpmLicenseField;
  path?: string;
  dependencies?: Record<string, NpmLsDependency>;
}

interface NpmLsTree {
  dependencies?: Record<string, NpmLsDependency>;
  problems?: string[];
}

function normalizeLicenseField(license: NpmLicenseField): string | undefined {
  if (typeof license === "string") return license;
  if (typeof license === "object" && license !== null && typeof license.type === "string") {
    return license.type;
  }
  return undefined;
}

// Walking the tree (rather than resolving each name once against a single
// node_modules/<name>/package.json) is what makes this correct for a nested,
// non-hoisted dependency, and for two tree positions that resolve to
// different versions of the same package with different licenses.
export function collectDependencyEntries(tree: NpmLsTree): LicenseEntry[] {
  const entries: LicenseEntry[] = [];
  const emitted = new Set<string>();

  // `ancestors` and `emitted` guard against different things and must stay
  // separate: `ancestors` is the current recursion path, so a node cannot
  // be its own descendant (real cycle protection); `emitted` is everything
  // ever visited, so the same package reached via two non-cyclic paths is
  // reported once. Gating recursion on `emitted` instead of `ancestors`
  // would silently drop a subtree the first time its root is reached via a
  // path with no children — npm's own tree cannot produce that shape, but
  // this function is exported and unit-tested directly against hand-built
  // fixtures, which can.
  function walk(
    deps: Record<string, NpmLsDependency> | undefined,
    ancestors: ReadonlySet<string>,
  ): void {
    if (deps === undefined) return;
    for (const [name, dep] of Object.entries(deps)) {
      const identity = dep.path ?? `${name}@${dep.version ?? "unknown"}`;
      if (ancestors.has(identity)) continue;

      if (!emitted.has(identity)) {
        emitted.add(identity);
        entries.push({
          name,
          license: normalizeLicenseField(dep.license),
          ...(dep.version !== undefined ? { version: dep.version } : {}),
        });
      }

      walk(dep.dependencies, new Set(ancestors).add(identity));
    }
  }

  walk(tree.dependencies, new Set());
  return entries;
}

function getDependencyTreeJson(): string {
  try {
    // execSync always goes through a shell, which is what lets this run
    // unmodified on both POSIX (/bin/sh) and Windows (cmd.exe, where npm is
    // a .cmd shim rather than a directly executable binary). The command is
    // a fixed literal with no untrusted interpolation. --long is what puts a
    // "license" field directly on every tree node, keyed to that node's own
    // resolved path rather than requiring a second by-name filesystem lookup.
    return execSync("npm ls --omit=dev --all --long --json", {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    // npm ls exits non-zero on a broken/extraneous tree even when the JSON
    // it printed to stdout is otherwise complete and exactly what we need.
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout !== undefined && stdout.length > 0) return stdout;
    throw error;
  }
}

function main(): void {
  const tree = JSON.parse(getDependencyTreeJson()) as NpmLsTree;

  if (tree.problems !== undefined && tree.problems.length > 0) {
    console.error("npm ls reported problems with the dependency tree:");
    for (const problem of tree.problems) {
      console.error(`  ${problem}`);
    }
    console.error(
      "License verdicts below may be incomplete or misleading until these are resolved.\n",
    );
  }

  const verdicts = classifyLicenses(collectDependencyEntries(tree));
  const disallowed = verdicts.filter((v) => !v.allowed);

  if (disallowed.length > 0) {
    console.error("Production dependencies with a disallowed or missing license:");
    for (const v of disallowed) {
      console.error(`  ${v.name}@${v.version ?? "unknown"}: ${v.license ?? "(no license field)"}`);
    }
    process.exit(1);
  }

  console.log(`All ${verdicts.length} production dependency license(s) allowed.`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
