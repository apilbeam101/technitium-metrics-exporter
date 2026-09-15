import { isIP } from "node:net";
import { deepFreeze } from "./deep-freeze.ts";
import { Secret } from "./secret.ts";
import type {
  AppConfig,
  LogFormat,
  LogLevel,
  MetricsTlsConfig,
  TargetConfig,
  TlsMinVersion,
} from "./types.ts";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface ValidationResult {
  readonly config: AppConfig;
  readonly warnings: readonly string[];
}

type EnvVars = Readonly<Record<string, string | undefined>>;

// D§6.1: case-insensitive, must start with an alphanumeric.
const TARGET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
// No "?" or "#": http/client.ts appends the allowlisted path directly onto
// this string rather than parsing and reconstructing it (D§6.1), so a query
// string or fragment here would swallow or discard that path instead of
// merely prefixing it.
const BASE_URL_PATTERN = /^https?:\/\/[^\s?#]+$/i;

// Matched case-insensitively so that a wrong-case key (e.g. a lowercased
// technitium_api_token__dns_a) is still recognised as an override *attempt*
// and can be rejected loudly below, rather than silently falling through
// every lookup as if it didn't exist — the exact failure mode D§6.1's
// orphan-override rule exists to prevent.
const OVERRIDE_PATTERN = /^TECHNITIUM_(API_TOKEN|CA_BUNDLE_PATH|TLS_INSECURE_SKIP_VERIFY)__(.+)$/i;

function overrideSuffixFor(targetName: string): string {
  return targetName.toUpperCase().replace(/-/g, "_");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function parseIntegerVar(
  vars: EnvVars,
  name: string,
  defaultValue: number,
  errors: string[],
  { min, max }: { min: number; max: number },
): number {
  const raw = nonEmpty(vars[name]);
  if (raw === undefined) return defaultValue;

  if (!/^\d+$/.test(raw)) {
    errors.push(`${name} must be a positive integer, got "${raw}"`);
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    errors.push(`${name} must be between ${min} and ${max}, got ${parsed}`);
    return defaultValue;
  }

  return parsed;
}

function parseBooleanVar(
  vars: EnvVars,
  name: string,
  defaultValue: boolean,
  errors: string[],
): boolean {
  const raw = nonEmpty(vars[name]);
  if (raw === undefined) return defaultValue;

  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;

  errors.push(`${name} must be "true" or "false", got "${raw}"`);
  return defaultValue;
}

function parseEnumVar<T extends string>(
  vars: EnvVars,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
  errors: string[],
): T {
  const raw = nonEmpty(vars[name]);
  if (raw === undefined) return defaultValue;

  const match = allowed.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  if (match !== undefined) return match;

  errors.push(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return defaultValue;
}

interface ParsedTargetName {
  readonly name: string;
  readonly baseUrl: string;
  readonly overrideSuffix: string;
}

interface ParsedTargetNames {
  readonly targets: readonly ParsedTargetName[];
  // Every override suffix belonging to a syntactically valid target name,
  // even one later dropped for an invalid URL or a name collision — so that
  // target's own overrides are reported against the error that actually
  // caused it to be dropped, not as an unrelated orphan-override error.
  readonly attemptedSuffixes: ReadonlySet<string>;
}

function parseTargetNames(vars: EnvVars, errors: string[]): ParsedTargetNames {
  const raw = nonEmpty(vars.TECHNITIUM_TARGETS);
  if (raw === undefined) {
    errors.push("TECHNITIUM_TARGETS is required (e.g. dns-a=https://dns-a.example.com:53443)");
    return { targets: [], attemptedSuffixes: new Set() };
  }

  const parsed: ParsedTargetName[] = [];
  const attemptedSuffixes = new Set<string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      errors.push("TECHNITIUM_TARGETS contains an empty entry");
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      errors.push(`TECHNITIUM_TARGETS entry "${trimmed}" is not in the form name=url`);
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const baseUrl = trimmed.slice(separatorIndex + 1).trim();

    if (!TARGET_NAME_PATTERN.test(name)) {
      errors.push(
        `TECHNITIUM_TARGETS target name "${name}" is invalid (must start with a letter or digit, ` +
          "and contain only letters, digits, - or _)",
      );
      continue;
    }

    attemptedSuffixes.add(overrideSuffixFor(name));

    if (!BASE_URL_PATTERN.test(baseUrl)) {
      errors.push(`TECHNITIUM_TARGETS target "${name}" has an invalid base URL "${baseUrl}"`);
      continue;
    }

    parsed.push({ name, baseUrl, overrideSuffix: overrideSuffixFor(name) });
  }

  const byLowerName = new Map<string, ParsedTargetName>();
  const byOverrideSuffix = new Map<string, ParsedTargetName>();
  const deduped: ParsedTargetName[] = [];

  for (const target of parsed) {
    const lowerName = target.name.toLowerCase();
    const nameCollision = byLowerName.get(lowerName);
    if (nameCollision !== undefined) {
      errors.push(`TECHNITIUM_TARGETS has duplicate target name "${target.name}"`);
      continue;
    }

    const suffixCollision = byOverrideSuffix.get(target.overrideSuffix);
    if (suffixCollision !== undefined) {
      errors.push(
        `TECHNITIUM_TARGETS target names "${suffixCollision.name}" and "${target.name}" both resolve ` +
          `to override suffix "${target.overrideSuffix}"`,
      );
      continue;
    }

    byLowerName.set(lowerName, target);
    byOverrideSuffix.set(target.overrideSuffix, target);
    deduped.push(target);
  }

  return { targets: deduped, attemptedSuffixes };
}

interface OrphanOverride {
  readonly key: string;
  // Set only when the key's suffix is a real target but the key itself is
  // not in canonical case — lets the error suggest the exact fix instead of
  // just saying "no such target", which would be misleading here.
  readonly expectedKey: string | undefined;
}

function findOrphanOverrides(
  vars: EnvVars,
  attemptedSuffixes: ReadonlySet<string>,
): OrphanOverride[] {
  const orphans: OrphanOverride[] = [];
  for (const key of Object.keys(vars)) {
    const match = OVERRIDE_PATTERN.exec(key);
    if (match === null) continue;

    const [, base, suffix] = match;
    if (base === undefined || suffix === undefined) continue;

    const upperSuffix = suffix.toUpperCase();
    const canonicalKey = `TECHNITIUM_${base.toUpperCase()}__${upperSuffix}`;
    const suffixIsKnown = attemptedSuffixes.has(upperSuffix);

    if (key !== canonicalKey || !suffixIsKnown) {
      orphans.push({ key, expectedKey: suffixIsKnown ? canonicalKey : undefined });
    }
  }
  return orphans.sort((a, b) => a.key.localeCompare(b.key));
}

function resolveTarget(
  parsedName: ParsedTargetName,
  vars: EnvVars,
  errors: string[],
): TargetConfig | undefined {
  const { name, baseUrl, overrideSuffix } = parsedName;

  const apiTokenValue =
    nonEmpty(vars[`TECHNITIUM_API_TOKEN__${overrideSuffix}`]) ??
    nonEmpty(vars.TECHNITIUM_API_TOKEN);
  if (apiTokenValue === undefined) {
    errors.push(
      `target "${name}" has no API token (set TECHNITIUM_API_TOKEN or TECHNITIUM_API_TOKEN__${overrideSuffix})`,
    );
    return undefined;
  }

  const caBundlePath =
    nonEmpty(vars[`TECHNITIUM_CA_BUNDLE_PATH__${overrideSuffix}`]) ??
    nonEmpty(vars.TECHNITIUM_CA_BUNDLE_PATH);

  const tlsInsecureSkipVerifyRaw =
    nonEmpty(vars[`TECHNITIUM_TLS_INSECURE_SKIP_VERIFY__${overrideSuffix}`]) ??
    nonEmpty(vars.TECHNITIUM_TLS_INSECURE_SKIP_VERIFY);
  let tlsInsecureSkipVerify = false;
  if (tlsInsecureSkipVerifyRaw !== undefined) {
    const lower = tlsInsecureSkipVerifyRaw.toLowerCase();
    if (lower === "true") tlsInsecureSkipVerify = true;
    else if (lower === "false") tlsInsecureSkipVerify = false;
    else {
      errors.push(
        `TLS_INSECURE_SKIP_VERIFY for target "${name}" must be "true" or "false", got "${tlsInsecureSkipVerifyRaw}"`,
      );
    }
  }

  return {
    name,
    baseUrl,
    apiToken: new Secret(apiTokenValue),
    caBundlePath,
    tlsInsecureSkipVerify,
  };
}

function parseMetricsTls(vars: EnvVars, errors: string[]): MetricsTlsConfig | undefined {
  const certPath = nonEmpty(vars.METRICS_TLS_CERT_PATH);
  const keyPath = nonEmpty(vars.METRICS_TLS_KEY_PATH);
  const clientCaPath = nonEmpty(vars.METRICS_TLS_CLIENT_CA_PATH);
  const minVersion = parseEnumVar<TlsMinVersion>(
    vars,
    "METRICS_TLS_MIN_VERSION",
    ["TLSv1.2", "TLSv1.3"],
    "TLSv1.2",
    errors,
  );

  if (certPath === undefined && keyPath === undefined) {
    if (clientCaPath !== undefined) {
      errors.push(
        "METRICS_TLS_CLIENT_CA_PATH requires METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH to also be set",
      );
    }
    return undefined;
  }

  if (certPath === undefined || keyPath === undefined) {
    errors.push("METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH must both be set, or neither");
    return undefined;
  }

  return { certPath, keyPath, clientCaPath, minVersion };
}

function parseMetricsBindAddress(vars: EnvVars, errors: string[]): string {
  const raw = nonEmpty(vars.METRICS_BIND_ADDRESS);
  if (raw === undefined) return "0.0.0.0";

  if (isIP(raw) === 0) {
    errors.push(`METRICS_BIND_ADDRESS must be a valid IPv4 or IPv6 address, got "${raw}"`);
    return "0.0.0.0";
  }

  return raw;
}

export function validate(vars: EnvVars): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { targets: parsedNames, attemptedSuffixes } = parseTargetNames(vars, errors);
  for (const orphan of findOrphanOverrides(vars, attemptedSuffixes)) {
    errors.push(
      orphan.expectedKey === undefined
        ? `${orphan.key} does not match any configured target name`
        : `${orphan.key} does not match any configured target override — did you mean "${orphan.expectedKey}"?`,
    );
  }

  const targets = parsedNames
    .map((parsedName) => resolveTarget(parsedName, vars, errors))
    .filter((target): target is TargetConfig => target !== undefined);

  const tlsSkippedTargets = targets.filter((t) => t.tlsInsecureSkipVerify).map((t) => t.name);
  if (tlsSkippedTargets.length > 0) {
    warnings.push(
      `TLS certificate verification disabled for target(s): ${tlsSkippedTargets.join(", ")}`,
    );
  }

  const metricsPort = parseIntegerVar(vars, "METRICS_PORT", 10053, errors, { min: 1, max: 65535 });
  const metricsBindAddress = parseMetricsBindAddress(vars, errors);
  const pollIntervalSeconds = parseIntegerVar(vars, "POLL_INTERVAL_SECONDS", 30, errors, {
    min: 1,
    max: 86400,
  });
  const clusterPollIntervalSeconds = parseIntegerVar(
    vars,
    "CLUSTER_POLL_INTERVAL_SECONDS",
    60,
    errors,
    { min: 1, max: 86400 },
  );

  let statsPollIntervalSeconds = parseIntegerVar(vars, "STATS_POLL_INTERVAL_SECONDS", 300, errors, {
    min: 1,
    max: 86400,
  });
  if (statsPollIntervalSeconds < 60) {
    warnings.push(
      `STATS_POLL_INTERVAL_SECONDS (${statsPollIntervalSeconds}) is below the 60-second floor ` +
        "imposed by reverse-DNS lookups this endpoint triggers on the DNS server; clamped to 60",
    );
    statsPollIntervalSeconds = 60;
  }

  const requestTimeoutSeconds = parseIntegerVar(vars, "REQUEST_TIMEOUT_SECONDS", 15, errors, {
    min: 1,
    max: 3600,
  });

  const enableClusterCollector = parseBooleanVar(vars, "ENABLE_CLUSTER_COLLECTOR", false, errors);
  const enableStatsCollector = parseBooleanVar(vars, "ENABLE_STATS_COLLECTOR", false, errors);
  const enableStatsQueryTypes = parseBooleanVar(vars, "ENABLE_STATS_QUERY_TYPES", false, errors);
  const zonesIncludeInternal = parseBooleanVar(vars, "ZONES_INCLUDE_INTERNAL", false, errors);
  const enableDefaultMetrics = parseBooleanVar(vars, "ENABLE_DEFAULT_METRICS", true, errors);

  const logLevel = parseEnumVar<LogLevel>(
    vars,
    "LOG_LEVEL",
    ["debug", "info", "warn", "error"],
    "info",
    errors,
  );
  const logFormat = parseEnumVar<LogFormat>(vars, "LOG_FORMAT", ["json", "text"], "json", errors);

  const metricsTls = parseMetricsTls(vars, errors);

  if (errors.length > 0) {
    throw new ConfigError(errors.join("\n"));
  }

  const config: AppConfig = {
    targets,
    metricsPort,
    metricsBindAddress,
    pollIntervalSeconds,
    clusterPollIntervalSeconds,
    statsPollIntervalSeconds,
    requestTimeoutSeconds,
    enableClusterCollector,
    enableStatsCollector,
    enableStatsQueryTypes,
    zonesIncludeInternal,
    enableDefaultMetrics,
    logLevel,
    logFormat,
    metricsTls,
  };

  return { config: deepFreeze(config), warnings };
}
