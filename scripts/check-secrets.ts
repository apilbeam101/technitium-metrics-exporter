import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchGitleaks } from "./fetch-gitleaks.ts";

// No --no-git flag: gitleaks defaults to scanning the full commit history
// via `git log -p`, which is the point of running this in CI rather than
// only checking the working tree.
async function main(): Promise<void> {
  const gitleaks = await fetchGitleaks(join(process.cwd(), ".local", "bin"));

  execFileSync(gitleaks, ["detect", "--source", ".", "--config", ".gitleaks.toml", "--redact"], {
    stdio: "inherit",
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
