import type { Registry } from "@prometheus-io/client";
import type { SessionInfo, SessionPermission } from "../api/session.ts";
import { parseSessionResponse } from "../api/session.ts";
import type { HttpClient } from "../http/client.ts";
import { type PollErrorReason, TechnitiumHttpError } from "../http/errors.ts";
import {
  applySessionFailure,
  applySessionSuccess,
  createSessionMetrics,
  type SessionMetrics,
} from "./session-metrics.ts";

const SESSION_GET_PATH = "/api/user/session/get";

interface CollectorPermissionRequirement {
  readonly collector: string;
  readonly section: string;
}

// D§3.1's permission table: which section's View grant each *other*
// collector needs before it's safe to enable. Session/identity itself, and
// the cluster peer state that rides it (D§3.2.9), needs none — this table
// deliberately has no entry for "session".
const COLLECTOR_PERMISSION_REQUIREMENTS: readonly CollectorPermissionRequirement[] = [
  { collector: "native", section: "Dashboard" },
  { collector: "zones", section: "Zones" },
  { collector: "stats", section: "Dashboard" },
  { collector: "cluster", section: "Administration" },
];

export interface SessionCollectorOptions {
  readonly httpClient: Pick<HttpClient, "get">;
  readonly registry: Registry;
  // Which other collectors are enabled, so this preflight can gate exactly
  // those against the token's actual permission map. Left to the caller
  // (config-derived) rather than read from AppConfig directly, so this
  // collector stays testable with a plain string array.
  readonly enabledCollectors: readonly string[];
  readonly warn: (message: string) => void;
}

export type SessionCollectResult =
  | { readonly kind: "success"; readonly info: SessionInfo }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

// A TypeError surfacing here is a malformed-body shape mismatch (e.g.
// clusterNodes present but not an array) that slipped past the envelope
// classification's own explicit "parse" throws — per D§5.7's reason
// taxonomy it belongs in "parse", not the catch-all "unknown".
function reasonOf(error: unknown): PollErrorReason {
  if (error instanceof TechnitiumHttpError) return error.reason;
  if (error instanceof TypeError) return "parse";
  return "unknown";
}

// Per-target startup/poll preflight: reaches session/get (no permission
// needed), derives technitium_up from the actual call outcome (N6, never a
// constant), and gates every other enabled collector against the token's
// real permission map with one loud warning apiece rather than a retry-and-
// error every cycle.
export class SessionCollector {
  readonly #httpClient: Pick<HttpClient, "get">;
  readonly #metrics: SessionMetrics;
  readonly #enabledCollectors: readonly string[];
  readonly #warn: (message: string) => void;
  readonly #warnedCollectors = new Set<string>();
  #wasFailing = false;

  constructor(options: SessionCollectorOptions) {
    this.#httpClient = options.httpClient;
    this.#metrics = createSessionMetrics(options.registry);
    this.#enabledCollectors = options.enabledCollectors;
    this.#warn = options.warn;
  }

  async collect(): Promise<SessionCollectResult> {
    let body: string;
    try {
      body = (await this.#httpClient.get(SESSION_GET_PATH)).body;
    } catch (error) {
      return this.#fail(error);
    }

    let info: SessionInfo;
    try {
      info = parseSessionResponse(body);
    } catch (error) {
      return this.#fail(error);
    }

    try {
      applySessionSuccess(this.#metrics, info);
    } catch (error) {
      return this.#fail(error);
    }

    this.#wasFailing = false;
    this.#applyPermissionGating(info.permissions);
    return { kind: "success", info };
  }

  // Warns once on the transition into failure, not on every failing cycle —
  // the same "state persists across calls" shape as #warnedCollectors below.
  #fail(error: unknown): SessionCollectResult {
    applySessionFailure(this.#metrics);
    const reason = reasonOf(error);
    if (!this.#wasFailing) {
      const message = error instanceof Error ? error.message : String(error);
      this.#warn(`session collector failed (${reason}): ${message}`);
      this.#wasFailing = true;
    }
    return { kind: "failure", reason };
  }

  #applyPermissionGating(permissions: Readonly<Record<string, SessionPermission>>): void {
    for (const { collector, section } of COLLECTOR_PERMISSION_REQUIREMENTS) {
      if (!this.#enabledCollectors.includes(collector)) continue;

      if (permissions[section]?.canView) {
        this.#metrics.collectorSuccess.remove({ collector });
        this.#warnedCollectors.delete(collector);
        continue;
      }

      this.#metrics.collectorSuccess.labels({ collector }).set(0);

      if (!this.#warnedCollectors.has(collector)) {
        this.#warn(
          `collector "${collector}" is enabled but the API token lacks ${section}: View — skipping`,
        );
        this.#warnedCollectors.add(collector);
      }
    }
  }
}
