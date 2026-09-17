import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { downloadVerified, sha256Hex } from "../../../scripts/verified-download.ts";

describe("sha256Hex", () => {
  it("matches a known digest", () => {
    assert.equal(
      sha256Hex(Buffer.from("hello")),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("downloadVerified", () => {
  const body = Buffer.from("archive contents");
  const correctSha256 = createHash("sha256").update(body).digest("hex");

  let baseUrl: string;
  let server: ReturnType<typeof createServer>;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/missing") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns the body when the digest matches", async () => {
    const result = await downloadVerified(`${baseUrl}/archive`, correctSha256);
    assert.deepEqual(result, body);
  });

  it("matches case-insensitively", async () => {
    const result = await downloadVerified(`${baseUrl}/archive`, correctSha256.toUpperCase());
    assert.deepEqual(result, body);
  });

  it("throws on a digest mismatch", async () => {
    await assert.rejects(
      () => downloadVerified(`${baseUrl}/archive`, "0".repeat(64)),
      /sha256 mismatch/,
    );
  });

  it("throws on a non-200 response", async () => {
    await assert.rejects(() => downloadVerified(`${baseUrl}/missing`, correctSha256), /404/);
  });
});
