import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OUTPUT_PATH = "dashboards/technitium-dns.json";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana's own variable-interpolation syntax, resolved at dashboard load time, not a JS template-string typo
const DATASOURCE = { type: "prometheus", uid: "${DS_PROMETHEUS}" };

interface GridPos {
  readonly h: number;
  readonly w: number;
  readonly x: number;
  readonly y: number;
}

interface Target {
  readonly expr: string;
  readonly legendFormat?: string;
}

interface QueryTarget extends Target {
  readonly refId: string;
}

interface Panel {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly gridPos: GridPos;
  readonly datasource: typeof DATASOURCE;
  readonly targets: QueryTarget[];
  readonly fieldConfig?: { readonly defaults: Record<string, unknown> };
  readonly description?: string;
}

let nextId = 1;

function row(title: string, y: number): Panel {
  return {
    id: nextId++,
    type: "row",
    title,
    gridPos: { h: 1, w: 24, x: 0, y },
    datasource: DATASOURCE,
    targets: [],
  };
}

// Grafana keys a panel's query responses by refId; every panel with more
// than one target needs distinct ones or one series silently overwrites the
// other's response in the render.
function assignRefIds(targets: Target[]): QueryTarget[] {
  return targets.map((target, i) => ({ ...target, refId: String.fromCharCode(65 + i) }));
}

function panel(
  type: string,
  title: string,
  gridPos: GridPos,
  targets: Target[],
  options?: {
    readonly fieldConfig?: { readonly defaults: Record<string, unknown> };
    readonly description?: string;
  },
): Panel {
  return {
    id: nextId++,
    type,
    title,
    gridPos,
    datasource: DATASOURCE,
    targets: assignRefIds(targets),
    ...(options?.fieldConfig === undefined ? {} : { fieldConfig: options.fieldConfig }),
    ...(options?.description === undefined ? {} : { description: options.description }),
  };
}

// Grafana's own stat/state-timeline color mapping: 0 renders red, 1 renders
// green. Every honest-health metric in this exporter (technitium_up,
// technitium_collector_success, technitium_server_version_supported) uses
// this exact 0/1 polarity, so one mapping is shared across the health row.
const HEALTH_FIELD_CONFIG = {
  defaults: {
    mappings: [
      {
        type: "value",
        options: { "0": { color: "red", text: "DOWN" }, "1": { color: "green", text: "UP" } },
      },
    ],
    thresholds: {
      mode: "absolute",
      steps: [
        { color: "red", value: null },
        { color: "green", value: 1 },
      ],
    },
  },
};

function buildPanels(): Panel[] {
  const panels: Panel[] = [];
  let y = 0;

  // Exporter health comes first: a dashboard that looks green while the
  // exporter is dead is the worst possible outcome (D§7).
  panels.push(row("Exporter health", y));
  y += 1;
  panels.push(
    panel("stat", "Scrape reachable", { h: 4, w: 4, x: 0, y }, [{ expr: 'up{job="technitium"}' }], {
      fieldConfig: HEALTH_FIELD_CONFIG,
    }),
    panel("stat", "Node reachable", { h: 4, w: 4, x: 4, y }, [{ expr: "technitium_up" }], {
      fieldConfig: HEALTH_FIELD_CONFIG,
    }),
    panel(
      "stat",
      "Collector success",
      { h: 4, w: 6, x: 8, y },
      [{ expr: "technitium_collector_success", legendFormat: "{{ collector }}" }],
      {
        fieldConfig: HEALTH_FIELD_CONFIG,
        description:
          "0 means either a poll attempt failed, or (if held at 0 indefinitely) the API token is missing the permission this collector needs and it has never run.",
      },
    ),
    panel("stat", "Cache age (seconds)", { h: 4, w: 5, x: 14, y }, [
      { expr: "technitium_exporter_cache_age_seconds" },
    ]),
    panel("stat", "Rendered series", { h: 4, w: 5, x: 19, y }, [
      { expr: "technitium_exporter_series" },
    ]),
  );
  y += 4;

  // Per-node overview: lifetime counters and current live gauges.
  panels.push(row("Per-node overview", y));
  y += 1;
  panels.push(
    panel("timeseries", "Query rate", { h: 6, w: 8, x: 0, y }, [
      { expr: "rate(technitium_queries_total[5m])", legendFormat: "{{ instance }}" },
    ]),
    panel("timeseries", "Cached vs. blocked rate", { h: 6, w: 8, x: 8, y }, [
      { expr: "rate(technitium_cached_total[5m])", legendFormat: "{{ instance }} cached" },
      { expr: "rate(technitium_blocked_total[5m])", legendFormat: "{{ instance }} blocked" },
    ]),
    panel("stat", "Uptime", { h: 6, w: 4, x: 16, y }, [{ expr: "technitium_uptime_seconds" }]),
    panel("stat", "Clients seen", { h: 6, w: 4, x: 20, y }, [{ expr: "technitium_clients_total" }]),
  );
  y += 6;

  // Zone health: SOA serial divergence is the headline panel (D§7).
  panels.push(row("Zone health", y));
  y += 1;
  panels.push(
    panel(
      "timeseries",
      "SOA serial divergence (max - min by zone)",
      { h: 7, w: 12, x: 0, y },
      [
        {
          expr: 'max by (zone) (technitium_zone_soa_serial{job="technitium"}) - min by (zone) (technitium_zone_soa_serial{job="technitium"})',
          legendFormat: "{{ zone }}",
        },
      ],
      {
        description:
          'Nonzero means at least one polled node is serving a different SOA serial for this zone. Assumes the scrape job is named "technitium" (this project\'s own install guides use job_name: technitium) — a differently-named job renders no data here rather than an error. Internal system zones will show spurious divergence here if ZONES_INCLUDE_INTERNAL is enabled.',
      },
    ),
    panel("state-timeline", "DNSSEC status", { h: 7, w: 6, x: 12, y }, [
      { expr: "technitium_zone_dnssec_status == 1", legendFormat: "{{ zone }}: {{ status }}" },
    ]),
    panel("stat", "Disabled zones", { h: 7, w: 3, x: 18, y }, [
      { expr: "sum(technitium_zone_disabled == 1)" },
    ]),
    panel("stat", "Zones by type", { h: 7, w: 3, x: 21, y }, [
      { expr: "technitium_zones_by_type", legendFormat: "{{ type }}" },
    ]),
  );
  y += 7;

  // Transfer health: secondary-family fields are conditionally present
  // (D§ "Absent vs. zero is a real distinction"), so these panels only ever
  // show zones that actually reported the field.
  panels.push(row("Transfer health", y));
  y += 1;
  panels.push(
    panel("timeseries", "Time to SOA expiry", { h: 6, w: 8, x: 0, y }, [
      {
        expr: "technitium_zone_expiry_timestamp_seconds - time()",
        legendFormat: "{{ zone }}",
      },
    ]),
    panel("stat", "Zones sync-failed", { h: 6, w: 4, x: 8, y }, [
      { expr: "sum(technitium_zone_sync_failed == 1)" },
    ]),
    panel("stat", "Zones notify-failed", { h: 6, w: 4, x: 12, y }, [
      { expr: "sum(technitium_zone_notify_failed == 1)" },
    ]),
    panel("stat", "Zones expired", { h: 6, w: 4, x: 16, y }, [
      { expr: "sum(technitium_zone_expired == 1)" },
    ]),
    panel(
      "stat",
      "Zone visibility (visible vs. reported)",
      { h: 6, w: 4, x: 20, y },
      [
        { expr: 'technitium_zones_visible{job="technitium"}', legendFormat: "visible" },
        { expr: 'technitium_zones_reported{job="technitium"}', legendFormat: "reported" },
      ],
      {
        description:
          'reported requires the opt-in stats collector (ENABLE_STATS_COLLECTOR=true); absent otherwise. Both queries assume the scrape job is named "technitium"; a differently-named job renders no data here rather than an error.',
      },
    ),
  );
  y += 6;

  // Protocol split: sliding-window gauges, never rate()/increase() targets
  // (D§ "Sliding-window values are gauges, never counters").
  panels.push(row("Protocol split", y));
  y += 1;
  panels.push(
    panel("timeseries", "Queries by protocol (window)", { h: 6, w: 6, x: 0, y }, [
      { expr: "technitium_stats_window_queries", legendFormat: "{{ protocol }}" },
    ]),
    panel("timeseries", "Queries by response type (window)", { h: 6, w: 6, x: 6, y }, [
      { expr: "technitium_stats_window_queries_by_response", legendFormat: "{{ response_type }}" },
    ]),
    panel("timeseries", "Queries by query type (window)", { h: 6, w: 6, x: 12, y }, [
      { expr: "technitium_stats_window_queries_by_type", legendFormat: "{{ query_type }}" },
    ]),
    panel(
      "stat",
      "Window length (seconds)",
      { h: 6, w: 6, x: 18, y },
      [{ expr: "technitium_stats_window_seconds" }],
      {
        description:
          "Every panel in this row is a sliding-window gauge covering this many seconds, not a rate — it steps down on every window slide rather than accumulating (D§5.4-5.5).",
      },
    ),
  );
  y += 6;

  // Cluster state: opt-in collector (D§ Phase 8), so these panels are
  // expected to show "No data" on a deployment without clustering enabled.
  panels.push(row("Cluster state", y));
  y += 1;
  panels.push(
    panel(
      "state-timeline",
      "Peer connection state",
      { h: 6, w: 12, x: 0, y },
      [
        {
          expr: "technitium_cluster_node_state == 1",
          legendFormat: "{{ node_name }}: {{ state }}",
        },
      ],
      {
        description:
          "Requires the opt-in cluster collector (ENABLE_CLUSTER_COLLECTOR=true); absent otherwise.",
      },
    ),
    panel("stat", "Cluster peers", { h: 6, w: 4, x: 12, y }, [
      { expr: "technitium_cluster_nodes" },
    ]),
    panel("stat", "Cluster initialized", { h: 6, w: 4, x: 16, y }, [
      { expr: "technitium_cluster_initialized" },
    ]),
    panel("stat", "Config last synced", { h: 6, w: 4, x: 20, y }, [
      { expr: "technitium_cluster_config_last_synced_timestamp_seconds" },
    ]),
  );

  return panels;
}

// A datasource-type template variable, not the __inputs/__requires form
// Grafana.com's own dashboard-sharing export produces: __inputs is only ever
// substituted by the "Import dashboard" UI flow, so a dashboard loaded by
// file-based provisioning (the deploy/ Docker and Kubernetes manifests'
// route) would keep the literal, invalid "${DS_PROMETHEUS}" datasource
// forever. A template variable is resolved by Grafana every time the
// dashboard model loads, regardless of how it got there, and needs no
// hardcoded datasource UID that could dangle.
function buildTemplating(): { list: unknown[] } {
  return {
    list: [
      {
        name: "DS_PROMETHEUS",
        label: "Prometheus",
        type: "datasource",
        query: "prometheus",
        current: {},
        hide: 0,
        refresh: 1,
        regex: "",
        skipUrlSync: false,
      },
    ],
  };
}

export function generateDashboard(): string {
  nextId = 1;

  const dashboard = {
    title: "Technitium DNS",
    uid: "technitium-dns",
    description:
      "Technitium DNS Server health, zone health, and cluster state, from technitium-metrics-exporter.",
    tags: ["technitium", "dns"],
    timezone: "browser",
    editable: true,
    schemaVersion: 39,
    version: 1,
    time: { from: "now-6h", to: "now" },
    refresh: "30s",
    templating: buildTemplating(),
    panels: buildPanels(),
  };

  return `${JSON.stringify(dashboard, null, 2)}\n`;
}

function main(): void {
  writeFileSync(OUTPUT_PATH, generateDashboard());
  console.log(`wrote ${OUTPUT_PATH}`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
