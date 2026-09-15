import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { afterEach, describe, it } from "node:test";
import { request } from "undici";
import { createAgent } from "../../../src/http/agent.ts";

const CERT_PATH = "test/support/tls/localhost-cert.pem";
const KEY_PATH = "test/support/tls/localhost-key.pem";

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(
      { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) },
      (_req, res) => res.end("ok"),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, url: `https://127.0.0.1:${port}/` });
    });
  });
}

let activeServer: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (activeServer === undefined) {
      resolve();
      return;
    }
    activeServer.close(() => resolve());
  });
  activeServer = undefined;
});

describe("createAgent", () => {
  it("rejects the server's self-signed certificate by default", async () => {
    const { server, url } = await startServer();
    activeServer = server;

    const agent = createAgent({ caBundlePath: undefined, tlsInsecureSkipVerify: false });
    await assert.rejects(() => request(url, { dispatcher: agent }));
  });

  it("trusts the server's certificate once its own CA bundle is configured", async () => {
    const { server, url } = await startServer();
    activeServer = server;

    const agent = createAgent({ caBundlePath: CERT_PATH, tlsInsecureSkipVerify: false });
    const response = await request(url, { dispatcher: agent });
    assert.equal(response.statusCode, 200);
    assert.equal(await response.body.text(), "ok");
  });

  it("accepts the self-signed certificate when tlsInsecureSkipVerify is set", async () => {
    const { server, url } = await startServer();
    activeServer = server;

    const agent = createAgent({ caBundlePath: undefined, tlsInsecureSkipVerify: true });
    const response = await request(url, { dispatcher: agent });
    assert.equal(response.statusCode, 200);
  });

  it("throws when the configured CA bundle path does not exist", () => {
    assert.throws(() =>
      createAgent({
        caBundlePath: "test/support/tls/does-not-exist.pem",
        tlsInsecureSkipVerify: false,
      }),
    );
  });
});
