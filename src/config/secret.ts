import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

// Guards N5 structurally: every read path a secret could leak through
// (string coercion, JSON.stringify, console.log/util.inspect) returns the
// same placeholder, so no call site has to remember to redact.
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
