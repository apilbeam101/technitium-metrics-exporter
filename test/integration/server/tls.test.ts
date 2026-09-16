import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import { Agent, request } from "undici";
import type { AppConfig } from "../../../src/config/types.ts";
import { createLogger } from "../../../src/log/logger.ts";
import { createRequestHandler } from "../../../src/server/routes.ts";
import { startServer } from "../../../src/server/server.ts";

const SERVER_CERT = "test/support/tls/localhost-cert.pem";
const SERVER_KEY = "test/support/tls/localhost-key.pem";
const CLIENT_CA = "test/support/tls/ca-cert.pem";
const CLIENT_CERT = "test/support/tls/client-cert.pem";
const CLIENT_KEY = "test/support/tls/client-key.pem";
const UNTRUSTED_CLIENT_CERT = "test/support/tls/untrusted-client-cert.pem";
const UNTRUSTED_CLIENT_KEY = "test/support/tls/untrusted-client-key.pem";

function baseConfig(metricsTls: AppConfig["metricsTls"]): AppConfig {
  return {
    targets: [],
    metricsPort: 0,
    metricsBindAddress: "127.0.0.1",
    pollIntervalSeconds: 30,
    clusterPollIntervalSeconds: 60,
    statsPollIntervalSeconds: 300,
    requestTimeoutSeconds: 15,
    enableClusterCollector: false,
    enableStatsCollector: false,
    enableStatsQueryTypes: false,
    zonesIncludeInternal: false,
    enableDefaultMetrics: false,
    logLevel: "error",
    logFormat: "text",
    metricsTls,
  };
}

async function withTlsServer(
  metricsTls: AppConfig["metricsTls"],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const config = baseConfig(metricsTls);
  const logger = createLogger({ level: "error", format: "text" });
  const handler = createRequestHandler({
    globalRegistry: new Registry(),
    getTargetRegistry: () => undefined,
    logger,
  });
  const started = await startServer(config, handler, logger);

  const address = started.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    await run(`https://127.0.0.1:${port}`);
  } finally {
    await started.close();
  }
}

describe("metrics server TLS", () => {
  it("accepts a request over plain TLS with no client certificate required", async () => {
    await withTlsServer(
      {
        certPath: SERVER_CERT,
        keyPath: SERVER_KEY,
        clientCaPath: undefined,
        minVersion: "TLSv1.2",
      },
      async (baseUrl) => {
        const agent = new Agent({
          connect: { ca: readFileSync(SERVER_CERT), rejectUnauthorized: true },
        });
        const response = await request(`${baseUrl}/healthz`, { dispatcher: agent });
        assert.equal(response.statusCode, 200);
        await response.body.text();
      },
    );
  });

  it("accepts an mTLS request bearing a client certificate signed by the configured CA", async () => {
    await withTlsServer(
      {
        certPath: SERVER_CERT,
        keyPath: SERVER_KEY,
        clientCaPath: CLIENT_CA,
        minVersion: "TLSv1.2",
      },
      async (baseUrl) => {
        const agent = new Agent({
          connect: {
            ca: readFileSync(SERVER_CERT),
            cert: readFileSync(CLIENT_CERT),
            key: readFileSync(CLIENT_KEY),
            rejectUnauthorized: true,
          },
        });
        const response = await request(`${baseUrl}/healthz`, { dispatcher: agent });
        assert.equal(response.statusCode, 200);
        await response.body.text();
      },
    );
  });

  it("rejects an mTLS request with no client certificate at all", async () => {
    await withTlsServer(
      {
        certPath: SERVER_CERT,
        keyPath: SERVER_KEY,
        clientCaPath: CLIENT_CA,
        minVersion: "TLSv1.2",
      },
      async (baseUrl) => {
        const agent = new Agent({
          connect: { ca: readFileSync(SERVER_CERT), rejectUnauthorized: true },
        });
        await assert.rejects(() => request(`${baseUrl}/healthz`, { dispatcher: agent }));
      },
    );
  });

  it("rejects an mTLS request bearing a client certificate from an unknown CA", async () => {
    await withTlsServer(
      {
        certPath: SERVER_CERT,
        keyPath: SERVER_KEY,
        clientCaPath: CLIENT_CA,
        minVersion: "TLSv1.2",
      },
      async (baseUrl) => {
        const agent = new Agent({
          connect: {
            ca: readFileSync(SERVER_CERT),
            cert: readFileSync(UNTRUSTED_CLIENT_CERT),
            key: readFileSync(UNTRUSTED_CLIENT_KEY),
            rejectUnauthorized: true,
          },
        });
        await assert.rejects(() => request(`${baseUrl}/healthz`, { dispatcher: agent }));
      },
    );
  });
});
