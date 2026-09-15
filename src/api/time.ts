import { TechnitiumHttpError } from "../http/errors.ts";

// D§3.2.10: `expiry`/`lastModified` carry seven fractional digits, and
// `admin/cluster/state`'s own `lastSeen` uses .NET's DateTime.MinValue as a
// "never" sentinel — documented as exactly "0001-01-01T00:00:00", with no `Z`
// suffix. Matched against the date/time core with optional fractional and
// timezone dressing, rather than the bare documented string only: checking
// it before any normalization means a differently-dressed sentinel (e.g.
// carrying seven zero fractional digits, or an explicit Z) still maps to
// "never" instead of silently becoming a year-1 timestamp.
const NEVER_SENTINEL_PATTERN = /^0001-01-01T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})?$/i;

const TIMEZONE_SUFFIX_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/i;
const FRACTIONAL_SECONDS_PATTERN = /\.(\d+)/;

// A timestamp with no timezone suffix is explicitly interpreted as UTC,
// regardless of the host's TZ, and any fractional-second precision beyond
// milliseconds is truncated rather than passed to Date.parse as-is.
export function parseDotNetTimestamp(value: string): number | undefined {
  if (NEVER_SENTINEL_PATTERN.test(value)) return undefined;

  let normalized = value.replace(
    FRACTIONAL_SECONDS_PATTERN,
    (_, digits: string) => `.${digits.slice(0, 3).padEnd(3, "0")}`,
  );

  if (!TIMEZONE_SUFFIX_PATTERN.test(normalized)) normalized = `${normalized}Z`;

  const epochMs = Date.parse(normalized);
  if (Number.isNaN(epochMs)) {
    throw new TechnitiumHttpError("parse", `invalid .NET timestamp: ${value}`);
  }

  return epochMs / 1000;
}
