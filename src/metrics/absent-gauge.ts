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
  #gauge: Gauge | undefined;

  constructor(registry: Registry, name: string, help: string) {
    this.#registry = registry;
    this.#name = name;
    this.#help = help;
  }

  set(value: number): void {
    this.#gauge ??= new Gauge({ name: this.#name, help: this.#help, registers: [this.#registry] });
    this.#gauge.set(value);
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
