import type { Gauge, Registry } from "@prometheus-io/client";
import { parseNativeMetricsText } from "../api/native-text.ts";
import type { HttpClient } from "../http/client.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import {
  applyNativeFailure,
  applyNativeSuccess,
  createNativeMetrics,
  type NativeMetrics,
} from "./native-metrics.ts";

const NATIVE_METRICS_PATH = "/api/dashboard/metrics/text";

export interface NativeCollectorOptions {
  readonly httpClient: Pick<HttpClient, "get">;
  readonly registry: Registry;
  // Created by session-metrics.ts and passed in so this collector's outcome
  // and session-collector.ts's own permission-gating write to the same
  // technitium_collector_success{collector="native"} series (D§4.4).
  readonly collectorSuccess: Gauge<"collector">;
}

export type NativeCollectResult =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

// D§5.4: normalises metrics/text's unstable, unlabelled lifetime counters
// into one stable technitium_-prefixed surface (R5, N8).
export class NativeCollector {
  readonly #httpClient: Pick<HttpClient, "get">;
  readonly #metrics: NativeMetrics;

  constructor(options: NativeCollectorOptions) {
    this.#httpClient = options.httpClient;
    this.#metrics = createNativeMetrics(options.registry, options.collectorSuccess);
  }

  async collect(): Promise<NativeCollectResult> {
    let body: string;
    try {
      body = (await this.#httpClient.get(NATIVE_METRICS_PATH)).body;
    } catch (error) {
      return this.#fail(error);
    }

    try {
      const counters = parseNativeMetricsText(body);
      applyNativeSuccess(this.#metrics, counters);
    } catch (error) {
      return this.#fail(error);
    }

    return { kind: "success" };
  }

  #fail(error: unknown): NativeCollectResult {
    applyNativeFailure(this.#metrics);
    return { kind: "failure", reason: reasonOfError(error) };
  }
}
