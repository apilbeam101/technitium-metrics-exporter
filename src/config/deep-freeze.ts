// Freezes the object graph, not just the top level: a validated AppConfig
// must be unable to drift after startup, including through a nested target
// entry or array that a caller mutates in place. A WeakSet — not
// Object.isFrozen — guards against cycles, because Object.freeze is shallow:
// a caller-frozen root with unfrozen children must still be descended into,
// not skipped as if already fully processed.
export function deepFreeze<T>(value: T): Readonly<T> {
  return freeze(value, new WeakSet());
}

function freeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);

  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    freeze((value as Record<string, unknown>)[key], seen);
  }

  return value;
}
