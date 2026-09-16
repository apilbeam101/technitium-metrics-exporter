import { type Dispatcher, request as undiciRequest } from "undici";
import type { Secret } from "../config/secret.ts";
import type { Clock } from "./clock.ts";
import { type PollErrorReason, TechnitiumHttpError } from "./errors.ts";
import { assertPathAllowed } from "./path-allowlist.ts";
import { withBudgetedRetry } from "./retry.ts";

export interface RawResponse {
  readonly statusCode: number;
  readonly body: string;
}

// D§5.7's telemetry for technitium_exporter_upstream_requests_total{endpoint,
// status_code} and its duration counterpart, fired once per real HTTP attempt
// (including a retried one) — including an attempt that never got a response
// at all (network/timeout), which is why it carries a PollErrorReason instead
// of a statusCode in that case. Either branch stays a bounded label value
// (N7): a real numeric status code, or one of http/errors.ts's own fixed
// reason strings — never a free-form error message.
export type UpstreamAttemptOutcome =
  | { readonly path: string; readonly durationMs: number; readonly statusCode: number }
  | { readonly path: string; readonly durationMs: number; readonly reason: PollErrorReason };

export type OnUpstreamAttempt = (outcome: UpstreamAttemptOutcome) => void;

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly apiToken: Secret;
  readonly dispatcher: Dispatcher;
  readonly clock: Clock;
  readonly budgetMs: number;
  readonly onUpstreamAttempt?: OnUpstreamAttempt;
}

// D§6.1: the base URL is an opaque prefix, never parsed or reconstructed —
// only concatenated with the (always-absolute) allowlisted path — so a
// target reachable only through a reverse-proxy path prefix keeps that
// prefix instead of having it silently discarded by URL's own base-relative
// resolution of an absolute path.
function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> | undefined,
): URL {
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(`${trimmedBase}${path}`);

  // Belt-and-braces alongside config/validate.ts's own rejection of "?"/"#"
  // in a base URL: a base URL containing either would otherwise swallow or
  // discard the allowlisted path during the string concatenation above,
  // reaching a different, unvalidated path instead of merely being
  // prefixed by it.
  if (!url.pathname.endsWith(path)) {
    throw new Error(`base URL "${baseUrl}" swallowed the allowlisted path "${path}"`);
  }

  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  return url;
}

function isRetryableReason(error: unknown): boolean {
  return (
    error instanceof TechnitiumHttpError &&
    (error.reason === "timeout" || error.reason === "network" || error.reason === "http_5xx")
  );
}

// get()-only, and never follows redirects: undici's request() does not
// install a redirect interceptor unless one is explicitly composed, and none
// is here, so a 3xx is returned to the caller as an ordinary RawResponse
// rather than chased via its Location header (D§6.3, D§3.2.5).
export class HttpClient {
  readonly #baseUrl: string;
  readonly #apiToken: Secret;
  readonly #dispatcher: Dispatcher;
  readonly #clock: Clock;
  readonly #budgetMs: number;
  readonly #onUpstreamAttempt: OnUpstreamAttempt | undefined;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiToken = options.apiToken;
    this.#dispatcher = options.dispatcher;
    this.#clock = options.clock;
    this.#budgetMs = options.budgetMs;
    this.#onUpstreamAttempt = options.onUpstreamAttempt;
  }

  async get(path: string, query?: Readonly<Record<string, string>>): Promise<RawResponse> {
    assertPathAllowed(path);
    const url = buildUrl(this.#baseUrl, path, query);

    return withBudgetedRetry(
      { clock: this.#clock, budgetMs: this.#budgetMs, isRetryable: isRetryableReason },
      (remainingMs) => this.#performAttempt(path, url, remainingMs),
    );
  }

  // Body reading is inside the same try as the request itself: a socket
  // reset or stall while streaming the body is exactly as much a network/
  // timeout failure as one during connect, and must carry the same
  // PollErrorReason rather than escaping unclassified.
  async #performAttempt(path: string, url: URL, remainingMs: number): Promise<RawResponse> {
    const startedAt = this.#clock.elapsed();
    let statusCode: number;
    let body: string;
    try {
      // Clamped to a non-negative integer: retry.ts reasons about the
      // backoff it intends to sleep, not what actually elapses, so a
      // slow-timer overshoot (a CPU-throttled container, a GC pause) can
      // still hand back a negative remainingMs — and AbortSignal.timeout()
      // throws RangeError on a negative value, not just a fractional one.
      // 0 is valid and aborts immediately, which is the honest outcome for
      // a budget that's already gone.
      const response = await undiciRequest(url, {
        method: "GET",
        dispatcher: this.#dispatcher,
        headers: { authorization: `Bearer ${this.#apiToken.reveal()}` },
        signal: AbortSignal.timeout(Math.max(remainingMs, 0)),
      });
      statusCode = response.statusCode;
      body = await response.body.text();
    } catch (error) {
      const durationMs = this.#clock.elapsed() - startedAt;
      if (error instanceof Error && error.name === "TimeoutError") {
        this.#onUpstreamAttempt?.({ path, durationMs, reason: "timeout" });
        throw new TechnitiumHttpError("timeout", `request to ${url.pathname} timed out`, {
          cause: error,
        });
      }
      this.#onUpstreamAttempt?.({ path, durationMs, reason: "network" });
      throw new TechnitiumHttpError("network", `request to ${url.pathname} failed`, {
        cause: error,
      });
    }

    const durationMs = this.#clock.elapsed() - startedAt;
    this.#onUpstreamAttempt?.({ path, durationMs, statusCode });

    if (statusCode >= 500) {
      throw new TechnitiumHttpError("http_5xx", `${url.pathname} returned HTTP ${statusCode}`);
    }

    return { statusCode, body };
  }
}
