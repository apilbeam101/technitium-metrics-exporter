import { loadBuildInfo } from "./version.ts";

const HELP_TEXT = `technitium-metrics-exporter

Usage: technitium-metrics-exporter [--env-file <path>] [--version] [--help]

Configuration is read from the process environment; see example.env for the
full reference. --env-file loads additional variables from a file, with the
process environment always taking precedence over it.
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
