import { TechnitiumHttpError } from "../http/errors.ts";

export type EnvelopeClassification<T> =
  | { readonly kind: "ok"; readonly response: T }
  | { readonly kind: "invalid-token" }
  | {
      readonly kind: "api-error";
      readonly errorMessage: string;
      readonly stackTrace: string | undefined;
    }
  | { readonly kind: "not-json" };

// D§3.2.14: which endpoints wrap their payload under `response` and which
// (only session/get) are flat is a static fact per endpoint, not something
// to infer from whether a `response` key happens to be present — inferring
// it would silently reclassify a wrapped endpoint that lost its `response`
// key (an upstream regression) as a valid flat response instead of a parse
// failure.
export type EnvelopePayloadShape = "flat" | "wrapped";

// D§3.2.1: the API returns HTTP 200 even on authentication failure, so status
// codes cannot be trusted — every response body is classified here instead,
// and every call site routes through this one function.
export function classifyEnvelope<T = unknown>(
  rawBody: string,
  payloadShape: EnvelopePayloadShape,
): EnvelopeClassification<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "not-json" };
  }

  if (typeof parsed !== "object" || parsed === null) return { kind: "not-json" };

  const envelope = parsed as Record<string, unknown>;

  if (envelope.status === "invalid-token") return { kind: "invalid-token" };

  if (envelope.status === "error") {
    const errorMessage = envelope.errorMessage;
    const stackTrace = envelope.stackTrace;
    return {
      kind: "api-error",
      errorMessage: typeof errorMessage === "string" ? errorMessage : "",
      stackTrace: typeof stackTrace === "string" ? stackTrace : undefined,
    };
  }

  if (envelope.status === "ok") {
    if (payloadShape === "flat") return { kind: "ok", response: envelope as T };
    if (!("response" in envelope)) return { kind: "not-json" };
    return { kind: "ok", response: envelope.response as T };
  }

  return { kind: "not-json" };
}

// The single point where a classification becomes the shared PollErrorReason
// taxonomy (D§5.7), so every collector fails the same way instead of each
// re-deriving its own mapping from envelope kind to reason.
export function assertOk<T>(classification: EnvelopeClassification<T>, context: string): T {
  switch (classification.kind) {
    case "ok":
      return classification.response;
    case "invalid-token":
      throw new TechnitiumHttpError("auth", `${context}: invalid API token`);
    case "api-error":
      throw new TechnitiumHttpError("api_error", `${context}: ${classification.errorMessage}`);
    case "not-json":
      throw new TechnitiumHttpError(
        "parse",
        `${context}: response was not a recognized JSON envelope`,
      );
  }
}
