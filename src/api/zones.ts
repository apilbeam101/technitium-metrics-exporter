import type { Zone } from "../domain/zone.ts";
import { TechnitiumHttpError } from "../http/errors.ts";
import { assertOk, classifyEnvelope } from "./envelope.ts";
import { parseDotNetTimestamp } from "./time.ts";

interface RawZone {
  readonly name: string;
  readonly type: string;
  readonly disabled: boolean;
  readonly dnssecStatus: string;
  readonly soaSerial: number;
  readonly lastModified: string;
  readonly internal?: boolean;
  readonly expiry?: string;
  readonly isExpired?: boolean;
  readonly syncFailed?: boolean;
  readonly notifyFailed?: boolean;
  readonly notifyFailedFor?: readonly string[];
  // Present when a zone belongs to a catalog (D§3.2.7), but this design's
  // metric surface has no use for catalog membership (D§4.2) — never read,
  // so it never reaches Zone and never gets exported.
}

interface RawZonesResponse {
  readonly zones: readonly RawZone[];
}

function parseZone(raw: RawZone): Zone {
  return {
    name: raw.name,
    type: raw.type,
    disabled: raw.disabled,
    dnssecStatus: raw.dnssecStatus,
    soaSerial: raw.soaSerial,
    lastModifiedSeconds: parseDotNetTimestamp(raw.lastModified),
    internal: raw.internal === true,
    expirySeconds: raw.expiry === undefined ? undefined : parseDotNetTimestamp(raw.expiry),
    isExpired: raw.isExpired,
    syncFailed: raw.syncFailed,
    notifyFailed: raw.notifyFailed,
    notifyFailedPeerCount: raw.notifyFailedFor?.length,
  };
}

// D§3.2.14: zones/list wraps its payload under `response`, alongside the
// top-level status/server fields.
export function parseZonesListResponse(rawBody: string): readonly Zone[] {
  const envelope = assertOk(classifyEnvelope<RawZonesResponse>(rawBody, "wrapped"), "zones/list");
  if (!Array.isArray(envelope.zones)) {
    throw new TechnitiumHttpError(
      "parse",
      "zones/list: response.zones was missing or not an array",
    );
  }
  return envelope.zones.map(parseZone);
}
