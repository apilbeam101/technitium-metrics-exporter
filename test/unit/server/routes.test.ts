import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { Registry } from "@prometheus-io/client";
import type { Logger } from "../../../src/log/logger.ts";
import { createRequestHandler } from "../../../src/server/routes.ts";

function fakeLogger(): Logger & {
  readonly errorCalls: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
} {
  const errorCalls: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
  return {
    errorCalls,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message, fields) => {
      errorCalls.push({ message, fields });
    },
  };
}

function fakeReq(url: string): IncomingMessage {
  // Only .url and .method are ever read by createRequestHandler's own
  // dispatch logic and by the route handlers it calls into — the full
  // IncomingMessage surface is irrelevant here, hence the single narrow cast
  // rather than implementing dozens of unused stream members.
  return { url, method: "GET" } as unknown as IncomingMessage;
}

interface FakeResponse {
  headersSent: boolean;
  statusCode: number;
  body: string;
  destroyed: boolean;
  writeHead(code: number, headers?: Record<string, string>): FakeResponse;
  end(chunk?: string): FakeResponse;
  destroy(): FakeResponse;
}

// Same rationale as fakeReq(): only the members routes.ts actually touches
// (headersSent, writeHead, end, destroy) are implemented, so the object is
// built against its own small interface rather than the full ServerResponse
// surface, with a single narrow cast at each call site.
function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    headersSent: false,
    statusCode: 0,
    body: "",
    destroyed: false,
    writeHead(code) {
      res.statusCode = code;
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.body = chunk;
      return res;
    },
    destroy() {
      res.destroyed = true;
      return res;
    },
  };
  return res;
}

describe("createRequestHandler error handling", () => {
  it("logs the failure and responds 500 when a route handler rejects before sending headers", async () => {
    const logger = fakeLogger();
    const globalRegistry = new Registry();
    globalRegistry.metrics = async () => {
      throw new Error("boom");
    };

    const handler = createRequestHandler({
      globalRegistry,
      getTargetRegistry: () => undefined,
      logger,
    });
    const res = fakeRes();
    handler(fakeReq("/metrics"), res as unknown as ServerResponse);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 500);
    assert.equal(res.destroyed, false);
    assert.equal(logger.errorCalls.length, 1);
    assert.equal(logger.errorCalls[0]?.fields?.error, "boom");
  });

  it("destroys the connection instead of hanging when headers were already sent before the failure", async () => {
    const logger = fakeLogger();
    const globalRegistry = new Registry();
    const res = fakeRes();
    globalRegistry.metrics = async () => {
      // Simulates the race the fix guards against: some earlier part of the
      // response has already been written by the time this rejects, so the
      // catch handler can no longer call writeHead()/end() again.
      res.writeHead(200, {});
      throw new Error("boom after headers");
    };

    const handler = createRequestHandler({
      globalRegistry,
      getTargetRegistry: () => undefined,
      logger,
    });
    handler(fakeReq("/metrics"), res as unknown as ServerResponse);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.destroyed, true);
    assert.equal(logger.errorCalls.length, 1);
  });
});
