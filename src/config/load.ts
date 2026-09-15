import { readFileSync } from "node:fs";

const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// A quoted value's content is taken verbatim, including any "#" inside it.
// An unquoted value ends at the first "#" preceded by whitespace — matching
// example.env's own `VALUE  # comment` style — so a bare inline comment
// doesn't get parsed in as part of the value.
function extractValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }

  const commentIndex = trimmed.search(/\s#/);
  return (commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex)).trim();
}

export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = ENV_LINE_PATTERN.exec(line);
    if (match === null) continue;

    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    vars[key] = extractValue(rawValue);
  }

  return vars;
}

function extractEnvFileArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--env-file") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--env-file requires a path argument");
      return value;
    }
    if (arg.startsWith("--env-file=")) return arg.slice("--env-file=".length);
  }
  return undefined;
}

// An env var present but set to "" is treated the same as absent, so it
// falls through to whatever the file (or a built-in default) provides
// instead of silently masking it — the same convention validate.ts's
// nonEmpty() applies everywhere else on this boundary.
function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") result[key] = value;
  }
  return result;
}

// Process environment always wins over the file, so an operator can override
// a single value (e.g. in a container) without editing the file it ships with.
export function loadEnv(
  argv: readonly string[],
  processEnv: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const envFilePath = extractEnvFileArg(argv);
  const fileVars = envFilePath === undefined ? {} : parseEnvFile(readFileSync(envFilePath, "utf8"));

  return { ...fileVars, ...withoutEmptyValues(processEnv) };
}
