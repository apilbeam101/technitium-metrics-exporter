export type StateSetClassification<T extends string> =
  | { readonly kind: "absent" }
  | { readonly kind: "recognized"; readonly value: T }
  | { readonly kind: "unrecognized"; readonly value: string };

// D§3.3: every bounded enumeration (zone type, dnssecStatus, cluster peer
// state/type, transport protocol, response type) is rendered as a state set
// — one series per possible value, exactly one set to 1 — and an
// unrecognized value increments a counter rather than silently vanishing or
// growing a fresh label value without bound (N7). This classification is
// deliberately metric-free: the caller owns the actual counter, so this stays
// trivially testable and reusable across every state-set metric.
export function classifyStateSetValue<T extends string>(
  value: string | undefined,
  recognizedValues: readonly T[],
): StateSetClassification<T> {
  if (value === undefined) return { kind: "absent" };
  if ((recognizedValues as readonly string[]).includes(value)) {
    return { kind: "recognized", value: value as T };
  }
  return { kind: "unrecognized", value };
}
