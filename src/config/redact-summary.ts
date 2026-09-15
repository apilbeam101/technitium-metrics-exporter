import type { AppConfig } from "./types.ts";

// apiToken is resolved to its redacted placeholder string here, not passed
// through as the live Secret: a summary must be inert on its own, not merely
// safe under the serializers this function happens to be tested against —
// reveal() must be structurally unreachable from the returned value.
export function redactSummary(config: AppConfig): Record<string, unknown> {
  return {
    targets: config.targets.map((target) => ({
      name: target.name,
      baseUrl: target.baseUrl,
      apiToken: target.apiToken.toString(),
      caBundlePath: target.caBundlePath,
      tlsInsecureSkipVerify: target.tlsInsecureSkipVerify,
    })),
    metricsPort: config.metricsPort,
    metricsBindAddress: config.metricsBindAddress,
    pollIntervalSeconds: config.pollIntervalSeconds,
    clusterPollIntervalSeconds: config.clusterPollIntervalSeconds,
    statsPollIntervalSeconds: config.statsPollIntervalSeconds,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
    enableClusterCollector: config.enableClusterCollector,
    enableStatsCollector: config.enableStatsCollector,
    enableStatsQueryTypes: config.enableStatsQueryTypes,
    zonesIncludeInternal: config.zonesIncludeInternal,
    enableDefaultMetrics: config.enableDefaultMetrics,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
    metricsTls: config.metricsTls,
  };
}
