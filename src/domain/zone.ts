// D§3.3's bounded enumeration for zone type.
export const ZONE_TYPES = [
  "Primary",
  "Secondary",
  "Stub",
  "Forwarder",
  "SecondaryForwarder",
  "Catalog",
  "SecondaryCatalog",
] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

// D§3.3's bounded enumeration for zone dnssecStatus.
export const DNSSEC_STATUSES = ["Unsigned", "SignedWithNSEC", "SignedWithNSEC3"] as const;
export type DnssecStatus = (typeof DNSSEC_STATUSES)[number];

// type and dnssecStatus are read as plain strings, not the narrowed unions
// above, the same way session.ts reads ClusterPeer.type/state as strings: an
// upstream value outside the recognized set must reach the state-set
// classifier as data, not get force-cast into a type that claims it can't
// happen.
export interface Zone {
  readonly name: string;
  readonly type: string;
  readonly disabled: boolean;
  readonly dnssecStatus: string;
  readonly soaSerial: number;
  // D§3.2.10: undefined only were lastModified to ever carry the .NET
  // DateTime.MinValue "never" sentinel, which no known upstream behaviour
  // produces for this field — parseDotNetTimestamp is reused here for its
  // fractional-precision and missing-timezone normalisation, not for its
  // sentinel handling.
  readonly lastModifiedSeconds: number | undefined;
  // D§3.2.7: present, and only ever true, on the server's own built-in
  // system zones; absent (never false) on every ordinary zone.
  readonly internal: boolean;
  // D§3.2.7: expiry/isExpired/syncFailed are present only on secondary-family
  // zones. undefined here means "absent from the response", not zero/false.
  readonly expirySeconds: number | undefined;
  readonly isExpired: boolean | undefined;
  readonly syncFailed: boolean | undefined;
  // D§3.2.7: notifyFailed/notifyFailedFor are present only on primary-family,
  // non-internal zones. D§5.2 reduces notifyFailedFor to a count rather than
  // exporting peer-name labels (N7).
  readonly notifyFailed: boolean | undefined;
  readonly notifyFailedPeerCount: number | undefined;
}

const SECONDARY_FAMILY = new Set<string>(["Secondary", "SecondaryForwarder", "SecondaryCatalog"]);
const PRIMARY_FAMILY = new Set<string>(["Primary", "Catalog"]);

export function isSecondaryFamily(type: string): boolean {
  return SECONDARY_FAMILY.has(type);
}

export function isPrimaryFamily(type: string): boolean {
  return PRIMARY_FAMILY.has(type);
}
