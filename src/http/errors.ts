// D§5.7's bounded reason set for `technitium_exporter_poll_errors_total{reason}`.
// `api_error` exists because the HTTP-200-with-error-envelope case (D§3.2.1)
// has no equivalent in a status-code-only taxonomy.
export type PollErrorReason =
  | "auth"
  | "timeout"
  | "network"
  | "http_5xx"
  | "parse"
  | "api_error"
  | "unknown";

export class TechnitiumHttpError extends Error {
  override readonly name = "TechnitiumHttpError";
  readonly reason: PollErrorReason;

  constructor(reason: PollErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}

// Shared by every collector's own catch block: a TypeError surfacing here is
// a malformed-body shape mismatch that slipped past a parser's own explicit
// "parse" throws, so it belongs in "parse", not the catch-all "unknown".
export function reasonOfError(error: unknown): PollErrorReason {
  if (error instanceof TechnitiumHttpError) return error.reason;
  if (error instanceof TypeError) return "parse";
  return "unknown";
}
