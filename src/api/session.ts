import { TechnitiumHttpError } from "../http/errors.ts";
import { assertOk, classifyEnvelope } from "./envelope.ts";
import { parseDotNetTimestamp } from "./time.ts";

export interface SessionPermission {
  readonly canView: boolean;
}

export interface ClusterPeer {
  readonly name: string;
  readonly type: string | undefined;
  readonly state: string | undefined;
  // Absent for the node's own entry, and unconfirmed for a peer that has
  // never connected (D§3.2.9) — both collapse to the same undefined here, so
  // either upstream behaviour renders as an absent series without a code
  // change once confirmed against a live cluster (D§5.6).
  readonly lastSeenSeconds: number | undefined;
}

export interface SessionInfo {
  readonly version: string;
  readonly dnsServerDomain: string;
  readonly clusterInitialized: boolean;
  readonly permissions: Readonly<Record<string, SessionPermission>>;
  // undefined when the target is not clustered. When clusterInitialized is
  // true, the peer inventory rides this same flat envelope with no extra
  // permission or call needed (D§3.2.9).
  readonly clusterPeers: readonly ClusterPeer[] | undefined;
}

interface RawClusterPeer {
  readonly name: string;
  readonly type?: string;
  readonly state?: string;
  readonly lastSeen?: string;
  // Present in the upstream response alongside identity/role/state, but
  // never read by parsePeer below, so they never reach ClusterPeer and are
  // never exported (D§4.2, D§5.6) — a compromised metrics store must not
  // become an inventory of internal network addresses.
  readonly address?: string;
  readonly url?: string;
}

interface RawSessionInfo {
  readonly version: string;
  readonly dnsServerDomain: string;
  readonly clusterInitialized?: boolean;
  readonly permissions: Readonly<Record<string, SessionPermission>>;
  // Field name pending confirmation against a real clustered server
  // (Phase 14): no upstream source for session/get's own response shape was
  // available to verify this against, unlike admin/cluster/state's "nodes".
  readonly clusterNodes?: readonly RawClusterPeer[];
}

interface RawSessionEnvelope {
  readonly info: RawSessionInfo;
}

function parsePeer(raw: RawClusterPeer): ClusterPeer {
  return {
    name: raw.name,
    type: raw.type,
    state: raw.state,
    lastSeenSeconds: raw.lastSeen === undefined ? undefined : parseDotNetTimestamp(raw.lastSeen),
  };
}

// D§3.2.14: session/get's envelope is flat — info and token sit directly
// alongside status/server, with no response wrapper. permissions and the
// cluster peer inventory are nested inside info, not siblings of it.
export function parseSessionResponse(rawBody: string): SessionInfo {
  const envelope = assertOk(classifyEnvelope<RawSessionEnvelope>(rawBody, "flat"), "session/get");
  const { info } = envelope;

  const clusterInitialized = info.clusterInitialized ?? false;

  let clusterPeers: readonly ClusterPeer[] | undefined;
  if (clusterInitialized) {
    if (info.clusterNodes === undefined) {
      throw new TechnitiumHttpError(
        "parse",
        "session/get: clusterInitialized was true but clusterNodes was absent from the response",
      );
    }
    clusterPeers = info.clusterNodes.map(parsePeer);
  }

  return {
    version: info.version,
    dnsServerDomain: info.dnsServerDomain,
    clusterInitialized,
    permissions: info.permissions,
    clusterPeers,
  };
}
