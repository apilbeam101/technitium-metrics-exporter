import { Gauge, type Registry } from "@prometheus-io/client";

// A label-free Gauge always renders exactly one series once constructed —
// reset() only zeroes its value, it cannot make the series disappear, since
// there's no label combination to remove. Several label-free metrics across
// this exporter (technitium_cluster_nodes, technitium_lifetime_counters'
// gauge fields, technitium_zones_visible/technitium_zones_excluded_internal)
// must instead be genuinely absent until they have a real value, and absent
// again once that value stops applying (a target losing clustering, a
// failed poll cycle) — this removes and recreates the underlying Gauge
// instead of resetting it, which is the only way to make a label-free
// series disappear.
export class AbsentUntilSetGauge {
  readonly #registry: Registry;
  readonly #name: string;
  readonly #help: string;
  // Only self-metrics.ts's own cache_age_seconds uses this — every other
  // caller wants an ordinary externally-.set() gauge. When present, the
  // underlying Gauge is built with this as its own collect() (see
  // #ensureGauge below for why the closure can reference `this.#gauge`
  // despite being constructed before that assignment completes).
  readonly #computeValue: (() => number) | undefined;
  #gauge: Gauge | undefined;

  constructor(registry: Registry, name: string, help: string, computeValue?: () => number) {
    this.#registry = registry;
    this.#name = name;
    this.#help = help;
    this.#computeValue = computeValue;
  }

  #ensureGauge(): Gauge {
    // computeValue's own collect() runs only at render time, by which point
    // this assignment has long since completed — the same "reference this
    // metric's own field from inside its own collect()" pattern
    // self-metrics.ts's _series gauge already relies on.
    this.#gauge ??= new Gauge({
      name: this.#name,
      help: this.#help,
      registers: [this.#registry],
      ...(this.#computeValue === undefined
        ? {}
        : { collect: () => this.#gauge?.set(this.#computeValue?.() ?? 0) }),
    });
    return this.#gauge;
  }

  set(value: number): void {
    this.#ensureGauge().set(value);
  }

  // Makes the underlying Gauge present without writing a value directly —
  // for a computeValue-driven gauge, where the value is always recomputed by
  // collect() at render time and never written from outside.
  ensurePresent(): void {
    this.#ensureGauge();
  }

  setOrClear(value: number | undefined): void {
    if (value === undefined) {
      this.clear();
      return;
    }
    this.set(value);
  }

  clear(): void {
    if (this.#gauge === undefined) return;
    this.#registry.removeSingleMetric(this.#name);
    this.#gauge = undefined;
  }
}
