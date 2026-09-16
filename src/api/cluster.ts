import { assertOk, classifyEnvelope } from "./envelope.ts";
import { parseDotNetTimestamp } from "./time.ts";

export interface ClusterConfigDetail {
  readonly heartbeatRefreshIntervalSeconds: number | undefined;
  readonly heartbeatRetryIntervalSeconds: number | undefined;
  readonly configRefreshIntervalSeconds: number | undefined;
  // D§3.2.10's documented never-sentinel belongs to this endpoint's own
  // nodes[].lastSeen, which D§5.6 doesn't export at all (that array
  // duplicates the peer identity/state/lastSeen session/get already supplies
  // with no permission, D§3.2.9, plus the network addresses D§4.2 excludes)
  // — nodes is never read below, so that documented sentinel behaviour is
  // never actually exercised by this parser. configLastSynced reuses the
  // same shared parseDotNetTimestamp defensively, since any .NET timestamp
  // field could in principle carry it, but no live capture has confirmed
  // this specific field ever does; undefined here covers both that
  // unconfirmed sentinel case and a genuinely absent field.
  readonly configLastSyncedSeconds: number | undefined;
}

interface RawClusterState {
  readonly heartbeatRefreshIntervalSeconds?: number;
  readonly heartbeatRetryIntervalSeconds?: number;
  readonly configRefreshIntervalSeconds?: number;
  readonly configLastSynced?: string;
  // clusterInitialized/dnsServerDomain/version/clusterDomain/nodes are all
  // outside D§5.6's four-metric surface for this endpoint —
  // clusterInitialized/dnsServerDomain/version already come from session/get
  // (D§3.2.9), and nodes duplicates that same call's peer inventory with the
  // network addresses D§4.2 excludes. serverIpAddresses is never requested
  // (this parser doesn't pass includeServerIpAddresses=true) so it never
  // arrives at all. configRetryIntervalSeconds appears in the published API
  // docs' example response but not in the real sanitised capture this
  // parser is tested against (test/fixtures/cluster/cluster-state.json) —
  // consistent with this project's general skepticism toward APIDOCS.md's
  // accuracy — so it's treated the same as any other field outside the
  // metric surface: never read, so never exported.
}

// D§3.2.14: admin/cluster/state wraps its payload under `response`, the same
// shape as zones/list and stats/get.
export function parseClusterStateResponse(rawBody: string): ClusterConfigDetail {
  const response = assertOk(
    classifyEnvelope<RawClusterState>(rawBody, "wrapped"),
    "admin/cluster/state",
  );

  return {
    heartbeatRefreshIntervalSeconds: response.heartbeatRefreshIntervalSeconds,
    heartbeatRetryIntervalSeconds: response.heartbeatRetryIntervalSeconds,
    configRefreshIntervalSeconds: response.configRefreshIntervalSeconds,
    configLastSyncedSeconds:
      response.configLastSynced === undefined
        ? undefined
        : parseDotNetTimestamp(response.configLastSynced),
  };
}
