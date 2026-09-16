import { loadBuildInfo } from "./version.ts";

const HELP_TEXT = `technitium-metrics-exporter

Usage: technitium-metrics-exporter [--env-file <path>] [--version] [--help]
                                    [--dump-raw]

Configuration is read from the process environment; see example.env for the
full reference. --env-file loads additional variables from a file, with the
process environment always taking precedence over it.

--dump-raw fetches every read-only endpoint for each configured target once,
writes the result as sanitised JSON to stdout, and exits — logging is
diverted entirely to stderr so stdout carries only the dump. Review the
output before sharing it: this redacts only the echoed session token and any
stackTrace, not real hostnames or IP addresses (see scripts/sanitize-fixtures.ts
for that separate step).
`;

// Returns true if a flag was recognized and handled (in which case the
// caller should exit without going on to load configuration or start the
// server) — --dump-raw is deliberately not handled here, it belongs to
// Phase 10.
export function handleCliFlags(argv: readonly string[], write: (text: string) => void): boolean {
  if (argv.includes("--version") || argv.includes("-v")) {
    write(`${loadBuildInfo().version}\n`);
    return true;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    write(HELP_TEXT);
    return true;
  }

  return false;
}
