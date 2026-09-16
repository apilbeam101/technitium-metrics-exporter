import type { AppConfig, TargetConfig } from "./config/types.ts";
import { createAgent } from "./http/agent.ts";
import { HttpClient } from "./http/client.ts";
import type { Clock } from "./http/clock.ts";

const REDACTED = "[REDACTED]";

// D§3.2.11/D§3.2.12: both secrets this dump could otherwise leak sit at the
// top level of their own response body — session/get's own echoed bearer
// token, and an error envelope's stackTrace — never nested, so redacting
// exactly these two keys at exactly this depth is sufficient (per this
// project's own prior confirmation against a live capture) without a
// generic deep-scan that could still miss a secret introduced somewhere else
// in the object tree while giving false confidence that it's covered.
const TOP_LEVEL_SECRET_KEYS = ["token", "stackTrace"] as const;

// Exported for its own unit test: the exit criterion "a test proves
// --dump-raw output cannot contain a token" is most directly proven against
// this function, independent of standing up a fake target.
export function redactRawBody(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — e.g. metrics/text's own dual-format success body is plain
    // Prometheus exposition text (D§3.2.1), which carries neither secret.
    return body;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;

  const redacted: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const key of TOP_LEVEL_SECRET_KEYS) {
    if (key in redacted) redacted[key] = REDACTED;
  }
  return redacted;
}

// This is a manual diagnostic/fixture-capture tool (IMPLEMENTATION.md Phase
// 14), not the regular poll cycle: every read-only endpoint is fetched
// unconditionally, regardless of ENABLE_STATS_COLLECTOR/ENABLE_CLUSTER_COLLECTOR,
// because a permission or "not clustered" failure captured here is itself
// useful diagnostic information, not something to suppress the same way the
// ordinary poll path auto-skips it.
const ENDPOINTS: ReadonlyArray<{
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
}> = [
  { path: "/api/user/session/get" },
  { path: "/api/zones/list" },
  { path: "/api/dashboard/metrics/text" },
  { path: "/api/dashboard/stats/get", query: { type: "LastHour" } },
  { path: "/api/admin/cluster/state" },
];

export type EndpointDump =
  | { readonly statusCode: number; readonly body: unknown }
  | { readonly error: string };

export type TargetDump = Readonly<Record<string, EndpointDump>> | { readonly error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ClientHandle {
  readonly client: Pick<HttpClient, "get">;
  readonly close: () => Promise<void>;
}

// The real, network-touching factory used by runDumpRaw's own default below.
// Overridable (mirrors TargetRegistryOptions.createHttpClient's own reason)
// so a test can inject a fake client instead of standing up a real
// Technitium server or a mock HTTP listener.
function defaultCreateClientHandle(
  target: TargetConfig,
  config: AppConfig,
  clock: Clock,
): ClientHandle {
  const dispatcher = createAgent({
    caBundlePath: target.caBundlePath,
    tlsInsecureSkipVerify: target.tlsInsecureSkipVerify,
  });
  const client = new HttpClient({
    baseUrl: target.baseUrl,
    apiToken: target.apiToken,
    dispatcher,
    clock,
    budgetMs: config.requestTimeoutSeconds * 1000,
  });
  return { client, close: () => dispatcher.close() };
}

export interface DumpRawOptions {
  readonly clock: Clock;
  readonly createClientHandle?: (
    target: TargetConfig,
    config: AppConfig,
    clock: Clock,
  ) => ClientHandle;
}

// Endpoint failures are caught individually so one endpoint's failure (e.g.
// a missing grant on admin/cluster/state) doesn't abort the rest of this
// target's own dump.
async function dumpTarget(
  target: TargetConfig,
  config: AppConfig,
  options: DumpRawOptions,
): Promise<Record<string, EndpointDump>> {
  const createClientHandle = options.createClientHandle ?? defaultCreateClientHandle;
  const { client, close } = createClientHandle(target, config, options.clock);

  try {
    const result: Record<string, EndpointDump> = {};
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await client.get(endpoint.path, endpoint.query);
        result[endpoint.path] = {
          statusCode: response.statusCode,
          body: redactRawBody(response.body),
        };
      } catch (error) {
        result[endpoint.path] = { error: errorMessage(error) };
      }
    }
    return result;
  } finally {
    await close();
  }
}

// A target-level failure (e.g. the default createClientHandle's createAgent()
// throwing synchronously because caBundlePath doesn't exist) is caught per
// target too, so one misconfigured target doesn't stop the dump for every
// other configured target — the same per-target isolation (N3) the regular
// poll path already gets from TargetRegistry.
export async function collectRawDump(
  config: AppConfig,
  options: DumpRawOptions,
): Promise<Readonly<Record<string, TargetDump>>> {
  const dump: Record<string, TargetDump> = {};
  for (const target of config.targets) {
    try {
      dump[target.name] = await dumpTarget(target, config, options);
    } catch (error) {
      dump[target.name] = { error: errorMessage(error) };
    }
  }
  return dump;
}

export async function runDumpRaw(
  config: AppConfig,
  options: DumpRawOptions,
  write: (text: string) => void,
): Promise<void> {
  const dump = await collectRawDump(config, options);
  write(`${JSON.stringify({ targets: dump }, null, 2)}\n`);
}
