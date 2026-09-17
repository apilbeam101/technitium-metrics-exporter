import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchPromtool } from "./fetch-promtool.ts";

async function main(): Promise<void> {
  const promtool = await fetchPromtool(join(process.cwd(), ".local", "bin"));

  execFileSync(promtool, ["check", "rules", "alerts/technitium-dns.yaml"], { stdio: "inherit" });
  execFileSync(promtool, ["test", "rules", "alerts/technitium-dns.test.yaml"], {
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
