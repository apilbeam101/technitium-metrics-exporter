import type { Secret } from "./secret.ts";

export interface TargetConfig {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiToken: Secret;
  readonly caBundlePath: string | undefined;
  readonly tlsInsecureSkipVerify: boolean;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "text";
export type TlsMinVersion = "TLSv1.2" | "TLSv1.3";

export interface MetricsTlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
  readonly clientCaPath: string | undefined;
  readonly minVersion: TlsMinVersion;
}

export interface AppConfig {
  readonly targets: readonly TargetConfig[];
  readonly metricsPort: number;
  readonly metricsBindAddress: string;
  readonly pollIntervalSeconds: number;
  readonly clusterPollIntervalSeconds: number;
  readonly statsPollIntervalSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly enableClusterCollector: boolean;
  readonly enableStatsCollector: boolean;
  readonly enableStatsQueryTypes: boolean;
  readonly zonesIncludeInternal: boolean;
  readonly enableDefaultMetrics: boolean;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;
  readonly metricsTls: MetricsTlsConfig | undefined;
}
