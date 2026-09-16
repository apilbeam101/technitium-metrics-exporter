import type { Counter, Gauge, Registry } from "@prometheus-io/client";
import { parseZonesListResponse } from "../api/zones.ts";
import type { HttpClient } from "../http/client.ts";
import { type PollErrorReason, reasonOfError } from "../http/errors.ts";
import {
  applyZoneFailure,
  applyZoneSuccess,
  createZoneMetrics,
  type ZoneMetrics,
} from "./zone-metrics.ts";

const ZONES_LIST_PATH = "/api/zones/list";

export interface ZoneCollectorOptions {
  readonly httpClient: Pick<HttpClient, "get">;
  readonly registry: Registry;
  // Created by session-metrics.ts and passed in so this collector's outcome
  // and unrecognized enum values land in the same
  // technitium_collector_success{collector="zones"} and
  // technitium_exporter_unknown_enum_total series session-collector.ts's
  // permission gating already writes to (D§4.4).
  readonly collectorSuccess: Gauge<"collector">;
  readonly unknownEnum: Counter<"metric" | "value">;
  // Mirrors ZONES_INCLUDE_INTERNAL (D§6.2): false (the default) excludes
  // internal system zones from every per-zone series; true is a no-op filter.
  readonly includeInternal: boolean;
}

export type ZoneCollectResult =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly reason: PollErrorReason };

// R1-R4's core deliverable: per-zone SOA serial, secondary transfer health,
// primary notify health and DNSSEC status, with the internal-zone filter and
// its excluded count always exported (D§3.2.7, D§5.2).
export class ZoneCollector {
  readonly #httpClient: Pick<HttpClient, "get">;
  readonly #metrics: ZoneMetrics;
  readonly #includeInternal: boolean;

  constructor(options: ZoneCollectorOptions) {
    this.#httpClient = options.httpClient;
    this.#metrics = createZoneMetrics(
      options.registry,
      options.collectorSuccess,
      options.unknownEnum,
    );
    this.#includeInternal = options.includeInternal;
  }

  async collect(): Promise<ZoneCollectResult> {
    let body: string;
    try {
      body = (await this.#httpClient.get(ZONES_LIST_PATH)).body;
    } catch (error) {
      return this.#fail(error);
    }

    try {
      const zones = parseZonesListResponse(body);
      applyZoneSuccess(this.#metrics, zones, this.#includeInternal);
    } catch (error) {
      return this.#fail(error);
    }

    return { kind: "success" };
  }

  #fail(error: unknown): ZoneCollectResult {
    applyZoneFailure(this.#metrics);
    return { kind: "failure", reason: reasonOfError(error) };
  }
}
