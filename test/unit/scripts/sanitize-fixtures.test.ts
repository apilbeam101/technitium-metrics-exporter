import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  checkPaths,
  findLeaks,
  resolveIoArgs,
  sanitize,
} from "../../../scripts/sanitize-fixtures.ts";

describe("resolveIoArgs", () => {
  it("resolves the input path from argv[0] when --out is absent", () => {
    assert.deepEqual(resolveIoArgs(["input.json"]), {
      inputPath: "input.json",
      outPath: undefined,
    });
  });

  it("resolves both paths when --out is present", () => {
    assert.deepEqual(resolveIoArgs(["input.json", "--out", "output.json"]), {
      inputPath: "input.json",
      outPath: "output.json",
    });
  });

  it("resolves the input path when --out precedes it", () => {
    assert.deepEqual(resolveIoArgs(["--out", "output.json", "input.json"]), {
      inputPath: "input.json",
      outPath: "output.json",
    });
  });

  it("resolves stdin's own '-' as the input path when --out is absent", () => {
    assert.deepEqual(resolveIoArgs(["-"]), { inputPath: "-", outPath: undefined });
  });

  it("leaves inputPath undefined when no arguments are given", () => {
    assert.deepEqual(resolveIoArgs([]), { inputPath: undefined, outPath: undefined });
  });
});

describe("findLeaks", () => {
  it("flags a routable public IPv4 address", () => {
    const leaks = findLeaks("upstream resolver at 8.8.8.8");
    assert.ok(leaks.some((l) => l.kind === "ip" && l.value === "8.8.8.8"));
  });

  it("does not flag documentation-range IPv4 addresses", () => {
    assert.deepEqual(findLeaks("192.0.2.10 198.51.100.20 203.0.113.30"), []);
  });

  it("does not flag private or loopback IPv4 addresses", () => {
    assert.deepEqual(findLeaks("10.0.0.1 172.16.5.5 192.168.1.1 127.0.0.1 169.254.1.1"), []);
  });

  it("flags a routable IPv6 address", () => {
    const leaks = findLeaks("resolver at 2606:4700:4700::1111");
    assert.ok(leaks.some((l) => l.kind === "ip" && l.value === "2606:4700:4700::1111"));
  });

  it("does not flag the IPv6 documentation range or loopback", () => {
    assert.deepEqual(findLeaks("2001:db8::1 ::1 fe80::1 fc00::1"), []);
  });

  it("does not misread an ISO 8601 time-of-day as an IPv6 address", () => {
    assert.deepEqual(findLeaks("2026-09-15T08:00:00.0000000"), []);
  });

  it("flags a real-looking domain", () => {
    const leaks = findLeaks("nameserver ns1.realcompany.example-registrar.net");
    assert.ok(leaks.some((l) => l.kind === "domain"));
  });

  it("does not flag the example.com/net/org/edu or arpa placeholder domains", () => {
    assert.deepEqual(
      findLeaks("example.com mail.example.com example.org example.net example.edu 0.in-addr.arpa"),
      [],
    );
  });

  it("does not misread a PascalCase code identifier as a domain", () => {
    assert.deepEqual(findLeaks("System.Exception at ExampleNamespace.ExampleMethod"), []);
  });

  it("does not misread a version number as a domain", () => {
    assert.deepEqual(findLeaks("version 15.4.0"), []);
  });

  it("flags a long contiguous alphanumeric run as token-shaped", () => {
    const leaks = findLeaks("token=abcdef0123456789abcdef0123456789abcdef");
    assert.ok(leaks.some((l) => l.kind === "token"));
  });

  it("does not flag a hyphenated placeholder token", () => {
    assert.deepEqual(findLeaks("REDACTED-EXAMPLE-TOKEN"), []);
  });

  it("does not flag an underscore-separated metric name", () => {
    assert.deepEqual(findLeaks("technitium_zones_excluded_internal_count_total_value_field"), []);
  });

  it("flags a routable IPv6 address immediately followed by sentence punctuation", () => {
    const leaks = findLeaks("cannot reach peer 2606:4700:4700::1111.");
    assert.ok(leaks.some((l) => l.kind === "ip" && l.value === "2606:4700:4700::1111"));
  });

  it("flags a routable IPv6 address that only string-prefix-matches the documentation range", () => {
    assert.ok(findLeaks("2001:db80::1").some((l) => l.kind === "ip" && l.value === "2001:db80::1"));
    assert.ok(findLeaks("2001:db8f::1").some((l) => l.kind === "ip" && l.value === "2001:db8f::1"));
  });

  it("does not flag a true 2001:db8::/32 documentation-range address", () => {
    assert.deepEqual(findLeaks("2001:db8::1 2001:db8:1::1 2001:0db8::1"), []);
  });

  it("does not misidentify the digits inside an in-addr.arpa reverse zone name as a leaked IPv4 address", () => {
    assert.deepEqual(findLeaks("5.2.0.192.in-addr.arpa"), []);
    assert.deepEqual(findLeaks("2.0.192.in-addr.arpa"), []);
  });

  it("does not misidentify the digits inside an ip6.arpa reverse zone name as a leaked address", () => {
    assert.deepEqual(
      findLeaks("1.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.0.0.1.5.6.6.0.1.0.8.2.0.a.2.ip6.arpa"),
      [],
    );
  });

  it("flags a routable IP elsewhere in the text while leaving an unrelated arpa zone name's digits unflagged", () => {
    const leaks = findLeaks("zone 5.2.0.192.in-addr.arpa is healthy; try upstream 8.8.8.8 instead");
    assert.ok(leaks.some((l) => l.kind === "ip" && l.value === "8.8.8.8"));
    assert.ok(!leaks.some((l) => l.value === "5.2.0.192"));
  });

  it("flags an address only string-prefix-matching fc00::/7 due to implicit zero-padding, while accepting genuine ULA addresses", () => {
    const leaks = findLeaks("fc::1 fbff::1 fc00::1 fdff:ffff::1");
    assert.ok(leaks.some((l) => l.kind === "ip" && l.value === "fc::1"));
    assert.ok(leaks.some((l) => l.kind === "ip" && l.value === "fbff::1"));
    assert.ok(!leaks.some((l) => l.value === "fc00::1"));
    assert.ok(!leaks.some((l) => l.value === "fdff:ffff::1"));
  });
});

describe("sanitize", () => {
  it("replaces a routable IPv4 address with a documentation-range address", () => {
    const result = sanitize("resolver 8.8.8.8 answered");
    assert.deepEqual(findLeaks(result), []);
    assert.ok(result.includes("192.0.2."));
  });

  it("replaces a real domain with an example.com subdomain, preserving structure", () => {
    const result = sanitize("host ns1.realcompany.example-registrar.net responded");
    assert.deepEqual(findLeaks(result), []);
    assert.ok(result.includes("example.com"));
  });

  it("replaces a token-shaped string with the fixed placeholder", () => {
    const result = sanitize("Authorization: Bearer abcdef0123456789abcdef0123456789abcdef");
    assert.deepEqual(findLeaks(result), []);
    assert.ok(result.includes("REDACTED-EXAMPLE-TOKEN"));
  });

  it("leaves already-safe content untouched", () => {
    const input = "example.com 192.0.2.1 2001:db8::1 REDACTED-EXAMPLE-TOKEN";
    assert.equal(sanitize(input), input);
  });
});

describe("checkPaths (the sanitisation guard)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "ttme-sanitize-fixtures-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes over a directory of properly sanitised fixtures", () => {
    const dir = join(root, "good");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({ dnsServerDomain: "dns-a.example.com", address: "192.0.2.5" }),
    );

    assert.deepEqual(checkPaths([dir]), []);
  });

  it("fails on a deliberately planted bad fixture containing a real public IP", () => {
    const dir = join(root, "bad-ip");
    mkdirSync(dir, { recursive: true });
    const planted = join(dir, "planted.json");
    writeFileSync(
      planted,
      JSON.stringify({ dnsServerDomain: "dns-a.example.com", address: "8.8.8.8" }),
    );

    const results = checkPaths([dir]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.file, planted);
    assert.ok(results[0]?.leaks.some((l) => l.kind === "ip" && l.value === "8.8.8.8"));
  });

  it("fails on a deliberately planted bad fixture containing a token-shaped string", () => {
    const dir = join(root, "bad-token");
    mkdirSync(dir, { recursive: true });
    const planted = join(dir, "planted.json");
    writeFileSync(planted, JSON.stringify({ token: "abcdef0123456789abcdef0123456789abcdef" }));

    const results = checkPaths([dir]);
    assert.equal(results.length, 1);
    assert.ok(results[0]?.leaks.some((l) => l.kind === "token"));
  });

  it("throws rather than vacuously passing when a check target does not exist", () => {
    const missing = join(root, "does-not-exist");
    assert.throws(() => checkPaths([missing]));
  });
});
