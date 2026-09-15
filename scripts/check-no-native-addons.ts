import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

// A compiled native addon always ships a .node binary somewhere in its
// package tree, regardless of how it got built, so scanning for that
// extension is a reliable signal independent of any particular build tool.
export function findNativeAddons(rootDir: string): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      // node_modules/.bin commonly holds symlinks to package CLI scripts;
      // a dangling one throws ENOENT on stat, which should skip that entry
      // rather than crash the whole scan.
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith(".node")) {
        found.push(relative(rootDir, fullPath));
      }
    }
  }

  walk(rootDir);
  return found.sort();
}

function main(): void {
  const nodeModulesDir = join(process.cwd(), "node_modules");

  // findNativeAddons returns [] for a missing directory too (that is the
  // correct answer for a generic recursive scan), but here it would let a
  // never-installed or wiped node_modules report a false "nothing found"
  // instead of the real problem: nothing was scanned at all.
  if (!existsSync(nodeModulesDir)) {
    console.error(`${nodeModulesDir} does not exist — run npm install first.`);
    process.exit(1);
  }

  const violations = findNativeAddons(nodeModulesDir);

  if (violations.length > 0) {
    console.error("Native addon binaries found in node_modules:");
    for (const violation of violations) {
      console.error(`  node_modules/${violation}`);
    }
    console.error(
      "\nThis project depends only on pure-JavaScript packages. Remove the offending dependency.",
    );
    process.exit(1);
  }

  console.log("No native addon binaries found.");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
