import { createHash } from "node:crypto";

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// Every caller pins the expected digest as a literal alongside the release
// version it was computed from, rather than fetching a checksums file fresh
// on every run — a checksums file published in the same release as the
// artifact proves nothing beyond "these two files came from the same place",
// since replacing one would let an attacker replace the other identically.
export async function downloadVerified(
  url: string,
  expectedSha256: string,
  timeoutMs = 60_000,
): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256Hex(buffer);
  const expected = expectedSha256.toLowerCase();
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}`);
  }

  return buffer;
}
