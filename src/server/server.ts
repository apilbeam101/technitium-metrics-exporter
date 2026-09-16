import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AppConfig } from "../config/types.ts";
import type { Logger } from "../log/logger.ts";

// Internal hardening constants, not AppConfig fields — D§6.2/validate.ts
// has no corresponding env var, and Phase 7's brief is explicit that these
// stay fixed defaults rather than becoming user-tunable knobs.
export const SERVER_HARDENING = {
  headersTimeoutMs: 60_000,
  requestTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
  maxHeaderSizeBytes: 32 * 1024,
  maxConnections: 256,
} as const;

export interface StartedServer {
  readonly server: http.Server | https.Server;
  close(): Promise<void>;
}

type RequestListener = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function buildServer(config: AppConfig, listener: RequestListener): http.Server | https.Server {
  const tls = config.metricsTls;
  if (tls === undefined) {
    return http.createServer({ maxHeaderSize: SERVER_HARDENING.maxHeaderSizeBytes }, listener);
  }

  const clientCaPath = tls.clientCaPath;
  const hasClientCa = clientCaPath !== undefined;
  const options: https.ServerOptions = {
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    minVersion: tls.minVersion,
    maxHeaderSize: SERVER_HARDENING.maxHeaderSizeBytes,
    // mTLS only when a client CA is configured: an unauthenticated client is
    // rejected outright rather than merely unverified (D§7).
    requestCert: hasClientCa,
    rejectUnauthorized: hasClientCa,
    ca: clientCaPath === undefined ? undefined : readFileSync(clientCaPath),
  };
  return https.createServer(options, listener);
}

export async function startServer(
  config: AppConfig,
  listener: RequestListener,
  logger: Logger,
): Promise<StartedServer> {
  const server = buildServer(config, listener);

  server.headersTimeout = SERVER_HARDENING.headersTimeoutMs;
  server.requestTimeout = SERVER_HARDENING.requestTimeoutMs;
  server.keepAliveTimeout = SERVER_HARDENING.keepAliveTimeoutMs;
  server.maxConnections = SERVER_HARDENING.maxConnections;

  logger.info("server hardening snapshot", {
    ...SERVER_HARDENING,
    tls: config.metricsTls !== undefined,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.metricsPort, config.metricsBindAddress, () => resolve());
  });

  // The startup-phase listener above is a `once` and already fired-or-not by
  // this point; left attached, it would silently swallow the *next* runtime
  // error by calling reject() on an already-settled promise, with no other
  // error handler on the listener at all. Replace it with a persistent one
  // that actually surfaces a post-listen server error instead.
  server.removeAllListeners("error");
  server.on("error", (error: Error) => {
    logger.error(`server error: ${error.message}`, { stack: error.stack });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
