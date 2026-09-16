import type { LogFormat, LogLevel } from "../config/types.ts";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: LogFormat;
  // --dump-raw reserves stdout for the sanitised JSON dump itself (Phase 10),
  // so every log line — including the debug/info half of the ordinary split
  // below — must go to stderr instead for that one entry point. Additive and
  // defaulted to false, so every existing caller and test keeps the ordinary
  // split unless it opts in.
  readonly allLogsToStderr?: boolean;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function formatLine(
  format: LogFormat,
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> | undefined,
): string {
  const time = new Date().toISOString();

  if (format === "json") {
    // Secret's own toJSON() (config/secret.ts) already returns the redaction
    // placeholder, so a field object that happens to still hold a live
    // Secret (rather than an already-redacted summary) stays safe here too
    // (N5) — this is the one guarantee this logger relies on rather than
    // re-implementing.
    return JSON.stringify({ ...fields, time, level, message });
  }

  const suffix =
    fields === undefined || Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
  return `${time} [${level}] ${message}${suffix}`;
}

// warn/error go to stderr, debug/info to stdout — the conventional split for
// a process whose stdout might otherwise be piped or captured as data.
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];

  function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = `${formatLine(options.format, level, message, fields)}\n`;
    if (options.allLogsToStderr === true || level === "warn" || level === "error") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
