import { Counter, Gauge, type Registry } from "@prometheus-io/client";
import type { ClusterPeer, SessionInfo } from "../api/session.ts";
import { classifyStateSetValue, type StateSetClassification } from "./state-set.ts";

// D§3.4: v15.0.0 is the minimum supported server version. `info.version` is
// observed as e.g. "15.4" (no patch component), so only the leading
// component is compared.
const MIN_SUPPORTED_MAJOR_VERSION = 15;

function isVersionSupported(version: string): boolean {
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major >= MIN_SUPPORTED_MAJOR_VERSION;
}

// A value genuinely absent upstream (undefined) is distinct from one that's
// present but outside the recognized set — both are counted, but under a
// value that can never collide with a real enum member, so the two failure
// modes stay distinguishable in the exported series (D§3.3).
function recordEnumOutcome(
  unknownEnum: Counter<"metric" | "value">,
  metric: string,
  classification: StateSetClassification<string>,
): void {
  switch (classification.kind) {
    case "recognized":
      return;
    case "unrecognized":
      unknownEnum.inc({ metric, value: classification.value });
      return;
    case "absent":
      unknownEnum.inc({ metric, value: "(absent)" });
      return;
    default: {
      const exhaustive: never = classification;
      void exhaustive;
      return;
    }
  }
}

// D§6.4's least-privilege procedure grants/restricts View at exactly these
// eleven section names — the token's permission map is keyed by them verbatim.
const PERMISSION_SECTIONS = [
  "Dashboard",
  "Zones",
  "Cache",
  "Allowed",
  "Blocked",
  "Apps",
  "DnsClient",
  "DhcpServer",
  "Logs",
  "Administration",
  "Settings",
] as const;

// D§3.3's bounded enumerations for the cluster peer inventory.
const CLUSTER_PEER_STATES = ["Unknown", "Self", "Connected", "Unreachable"] as const;
const CLUSTER_PEER_TYPES = ["Primary", "Secondary"] as const;

// A Gauge with no label dimension always renders exactly one series once
// constructed — reset() only zeroes its value, it cannot make the series
// disappear, since there is no label combination to remove. technitium_-
// cluster_nodes must be genuinely absent (not zero) for a non-clustered
// target, same as its two labelled neighbours (D§5.6), so this wrapper
// removes and recreates the underlying Gauge instead of resetting it.
class ClusterNodeCountGauge {
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

  clear(): void {
    if (this.#gauge === undefined) return;
    this.#registry.removeSingleMetric(this.#name);
    this.#gauge = undefined;
  }
}

export interface SessionMetrics {
  readonly up: Gauge;
  readonly permissionGranted: Gauge<"section">;
  readonly clusterInitialized: Gauge;
  readonly collectorSuccess: Gauge<"collector">;
  readonly clusterNodeState: Gauge<"node_name" | "node_type" | "state">;
  readonly clusterNodeLastSeen: Gauge<"node_name">;
  readonly clusterNodes: ClusterNodeCountGauge;
  readonly unknownEnum: Counter<"metric" | "value">;
  readonly serverVersionInfo: Gauge<"version">;
  readonly serverVersionSupported: Gauge;
  readonly serverDomainInfo: Gauge<"dns_server_domain">;
}

// Every gauge/counter is registered only into the Registry passed in
// (registers: [registry], not the library's own global default), so a
// per-target Registry (D§4.4) stays fully isolated and this collector is
// unit-testable without touching global state.
export function createSessionMetrics(registry: Registry): SessionMetrics {
  const registers = [registry];

  return {
    up: new Gauge({
      name: "technitium_up",
      help: "1 if and only if the last poll cycle reached this node and the token was accepted",
      registers,
    }),
    permissionGranted: new Gauge<"section">({
      name: "technitium_permission_granted",
      help: "Whether the configured API token has View permission on this section",
      labelNames: ["section"],
      registers,
    }),
    clusterInitialized: new Gauge({
      name: "technitium_cluster_initialized",
      help: "1 if this node has clustering initialised",
      registers,
    }),
    collectorSuccess: new Gauge<"collector">({
      name: "technitium_collector_success",
      help: "Per-collector outcome of the last poll cycle",
      labelNames: ["collector"],
      registers,
    }),
    clusterNodeState: new Gauge<"node_name" | "node_type" | "state">({
      name: "technitium_cluster_node_state",
      help: "Cluster peer connection state, as a state set",
      labelNames: ["node_name", "node_type", "state"],
      registers,
    }),
    clusterNodeLastSeen: new Gauge<"node_name">({
      name: "technitium_cluster_node_last_seen_timestamp_seconds",
      help: "Cluster peer last-seen time; absent for this node's own entry",
      labelNames: ["node_name"],
      registers,
    }),
    clusterNodes: new ClusterNodeCountGauge(
      registry,
      "technitium_cluster_nodes",
      "Number of entries in the cluster peer inventory, including this node",
    ),
    unknownEnum: new Counter<"metric" | "value">({
      name: "technitium_exporter_unknown_enum_total",
      help: "Count of enum values seen from the API that are outside this exporter's recognized set",
      labelNames: ["metric", "value"],
      registers,
    }),
    serverVersionInfo: new Gauge<"version">({
      name: "technitium_server_version_info",
      help: "Always 1; the node's reported Technitium version",
      labelNames: ["version"],
      registers,
    }),
    serverVersionSupported: new Gauge({
      name: "technitium_server_version_supported",
      help: "0 if the node's reported version is below the minimum supported v15.0",
      registers,
    }),
    serverDomainInfo: new Gauge<"dns_server_domain">({
      name: "technitium_server_domain_info",
      help: "Always 1; the node's own canonical DNS server domain, for detecting a mis-pointed target",
      labelNames: ["dns_server_domain"],
      registers,
    }),
  };
}

// up (N6) is set first here, the opposite of applySessionSuccess's last-write
// ordering below: on failure the safety property is that up=0 must land even
// if a later clear in this function were ever to throw, not that it must wait
// on everything else succeeding first. Cluster peer series must go absent
// (not freeze at their last value) on a failed cycle too — a hard-down or
// auth-rejected node has no cluster claims to make (D§4.4). Reusing
// applyClusterPeers(..., undefined) here is exactly the same reset it
// performs on the "not clustered" branch of a success.
export function applySessionFailure(metrics: SessionMetrics): void {
  metrics.up.set(0);
  applyClusterPeers(metrics, undefined);
  metrics.collectorSuccess.labels({ collector: "session" }).set(0);
}

// up (N6) and collector_success are set last, only once every other write in
// this function has already succeeded — a throw partway through (e.g. an
// unexpected shape in info.permissions) must not leave technitium_up at 1
// for a poll cycle that didn't actually finish applying its result.
export function applySessionSuccess(metrics: SessionMetrics, info: SessionInfo): void {
  metrics.clusterInitialized.set(info.clusterInitialized ? 1 : 0);

  for (const section of PERMISSION_SECTIONS) {
    metrics.permissionGranted.labels({ section }).set(info.permissions[section]?.canView ? 1 : 0);
  }

  applyClusterPeers(metrics, info.clusterPeers);

  metrics.serverVersionInfo.reset();
  metrics.serverVersionInfo.labels({ version: info.version }).set(1);
  metrics.serverVersionSupported.set(isVersionSupported(info.version) ? 1 : 0);
  metrics.serverDomainInfo.reset();
  metrics.serverDomainInfo.labels({ dns_server_domain: info.dnsServerDomain }).set(1);

  metrics.up.set(1);
  metrics.collectorSuccess.labels({ collector: "session" }).set(1);
}

// Reset-then-repopulate on every successful poll, not just on failure: this
// is what makes a peer removed between polls disappear from the state set
// instead of freezing at its last observed value (D§4.4's series-
// disappearance guarantee, applied here directly since Phase 7's per-target
// render/reset machinery doesn't exist yet).
function applyClusterPeers(
  metrics: SessionMetrics,
  peers: readonly ClusterPeer[] | undefined,
): void {
  metrics.clusterNodeState.reset();
  metrics.clusterNodeLastSeen.reset();

  if (peers === undefined) {
    metrics.clusterNodes.clear();
    return;
  }

  metrics.clusterNodes.set(peers.length);

  for (const peer of peers) {
    const typeClassification = classifyStateSetValue(peer.type, CLUSTER_PEER_TYPES);
    recordEnumOutcome(metrics.unknownEnum, "cluster_node_type", typeClassification);
    const nodeType =
      typeClassification.kind === "recognized"
        ? typeClassification.value
        : typeClassification.kind === "absent"
          ? "(absent)"
          : "unrecognized";

    const stateClassification = classifyStateSetValue(peer.state, CLUSTER_PEER_STATES);
    recordEnumOutcome(metrics.unknownEnum, "cluster_node_state", stateClassification);

    for (const candidate of CLUSTER_PEER_STATES) {
      const isActual =
        stateClassification.kind === "recognized" && candidate === stateClassification.value;
      metrics.clusterNodeState
        .labels({ node_name: peer.name, node_type: nodeType, state: candidate })
        .set(isActual ? 1 : 0);
    }

    if (peer.lastSeenSeconds !== undefined) {
      metrics.clusterNodeLastSeen.labels({ node_name: peer.name }).set(peer.lastSeenSeconds);
    }
  }
}
