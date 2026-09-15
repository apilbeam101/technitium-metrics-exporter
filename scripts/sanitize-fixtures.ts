import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type LeakKind = "ip" | "domain" | "token";
export interface Leak {
  kind: LeakKind;
  value: string;
}

// TEST-NET-1/2/3 (RFC 5737), private (RFC 1918), loopback, link-local and the
// unspecified/broadcast addresses are the ranges a hand-authored or captured
// fixture can legitimately contain without describing real infrastructure.
// Callers only ever pass an address node:net has already confirmed is valid.
function isSafeIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;
  if (a === 255 && b === 255 && parts[2] === 255 && parts[3] === 255) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3

  return false;
}

// 2001:db8::/32 is the IPv6 documentation range; fc00::/7 is unique local
// (private); fe80::/10 is link-local; ::1 and :: are loopback/unspecified.
// String-prefix matching on the raw text is not enough: "2001:db80::1" and
// "2001:db8f::1" both pass a naive startsWith("2001:db8") check despite being
// routable, distinct /32s — the second hextet must be exactly "db8"/"0db8",
// not merely start with those characters. The same reasoning applies to the
// first byte of the fc00::/7 ULA range.
function isSafeIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;

  const groups = lower.split(":");
  const first = groups[0];
  if (first === undefined) return false;

  const second = groups[1];
  if (first === "2001" && (second === "db8" || second === "0db8")) return true;

  const firstHextet = first === "" ? 0 : Number.parseInt(first.padStart(4, "0"), 16);
  const firstByte = firstHextet >> 8;
  if (firstByte === 0xfc || firstByte === 0xfd) return true;

  if (lower.startsWith("fe80")) return true;

  return false;
}

const ALLOWED_DOMAIN_SUFFIXES = [
  "example.com",
  "example.net",
  "example.org",
  "example.edu",
  "arpa",
];

function isSafeDomain(domain: string): boolean {
  return ALLOWED_DOMAIN_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
  );
}

const IPV4_CANDIDATE_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// A zero-compressed address such as "2606:4700:4700::1111" has no word-char
// boundary immediately before its leading digit in every case (a bare "::1"
// has none at all, since ":" is not a word character), so \b cannot delimit
// it reliably. Grabbing the maximal run of hex/colon characters and handing
// each candidate to node:net's own parser — rather than hand-rolling the
// zero-compression grammar in a regex — is what avoids the two failure modes
// that grammar invites: truncating at the "::" (dropping everything after
// it) and misreading a plain HH:MM:SS timestamp as an address.
//
// "." is deliberately excluded from both boundary assertions (unlike the
// hex/colon characters themselves, which must not extend past the match):
// a trailing "." — sentence punctuation, or a domain boundary — is a
// legitimate terminator, not a character the address can be confused with,
// since "." is not in the match's own character class. Including it in the
// lookaround previously made a greedy match's every possible backtrack
// position fail simultaneously whenever the run was followed by a period,
// silently dropping the address (e.g. "peer 2606:4700:4700::1111.").
const IPV6_CANDIDATE_PATTERN = /(?<![0-9a-fA-F:])[0-9a-fA-F:]{2,}(?![0-9a-fA-F:])/g;

// A reverse-DNS zone name such as "5.2.0.192.in-addr.arpa" or the nibble-form
// "8.b.d.0.1.0.0.2.ip6.arpa" is a dotted run of hex digits that legitimately
// contains an embedded IPv4-shaped or hex/digit-shaped substring — that is
// the zone name's actual content, not a leaked address. Spans matching this
// pattern are excluded from both IP patterns above before they're checked
// against node:net's parser.
const ARPA_DOMAIN_PATTERN =
  /\b(?:[0-9a-fA-F](?:[0-9a-fA-F-]*[0-9a-fA-F])?\.)+(?:in-addr|ip6)\.arpa\b/gi;

function arpaSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(ARPA_DOMAIN_PATTERN)) {
    const index = match.index;
    spans.push([index, index + match[0].length]);
  }
  return spans;
}

function withinArpaSpan(index: number, length: number, spans: Array<[number, number]>): boolean {
  return spans.some(([start, end]) => index >= start && index + length <= end);
}

// Lowercase-only by design: real domain names are conventionally written
// lowercase, while the PascalCase/camelCase identifiers that show up in
// stack traces and error text (e.g. "System.Exception") are not — this is
// what keeps hand-authored prose from being misread as a leaked hostname.
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/g;

// Hand-authored and captured fixture content has no legitimate reason to
// contain a 32+ character contiguous run of base64/hex characters; that
// shape is specific enough to API tokens and secrets to flag on sight.
const TOKEN_PATTERN = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;

export function findLeaks(text: string): Leak[] {
  const leaks: Leak[] = [];
  const spans = arpaSpans(text);

  for (const match of text.matchAll(IPV4_CANDIDATE_PATTERN)) {
    if (withinArpaSpan(match.index, match[0].length, spans)) continue;
    const value = match[0];
    if (isIPv4(value) && !isSafeIpv4(value)) leaks.push({ kind: "ip", value });
  }

  for (const match of text.matchAll(IPV6_CANDIDATE_PATTERN)) {
    if (withinArpaSpan(match.index, match[0].length, spans)) continue;
    const value = match[0];
    if (isIPv6(value) && !isSafeIpv6(value)) leaks.push({ kind: "ip", value });
  }

  for (const match of text.matchAll(DOMAIN_PATTERN)) {
    const value = match[0];
    if (!isSafeDomain(value)) leaks.push({ kind: "domain", value });
  }

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    leaks.push({ kind: "token", value: match[0] });
  }

  return leaks;
}

let ipv4Counter = 0;
let ipv6Counter = 0;
const domainReplacements = new Map<string, string>();

export function sanitize(text: string): string {
  const ipv4Spans = arpaSpans(text);
  let result = text.replace(IPV4_CANDIDATE_PATTERN, (match, offset: number) => {
    if (withinArpaSpan(offset, match.length, ipv4Spans)) return match;
    if (!isIPv4(match) || isSafeIpv4(match)) return match;
    ipv4Counter = (ipv4Counter % 254) + 1;
    return `192.0.2.${ipv4Counter}`;
  });

  const ipv6Spans = arpaSpans(result);
  result = result.replace(IPV6_CANDIDATE_PATTERN, (match, offset: number) => {
    if (withinArpaSpan(offset, match.length, ipv6Spans)) return match;
    if (!isIPv6(match) || isSafeIpv6(match)) return match;
    ipv6Counter += 1;
    return `2001:db8::${ipv6Counter.toString(16)}`;
  });

  result = result.replace(DOMAIN_PATTERN, (match) => {
    if (isSafeDomain(match)) return match;
    let replacement = domainReplacements.get(match);
    if (replacement === undefined) {
      const labels = match.split(".");
      const subdomain = labels.slice(0, -2);
      replacement = subdomain.length > 0 ? `${subdomain.join(".")}.example.com` : "example.com";
      domainReplacements.set(match, replacement);
    }
    return replacement;
  });

  result = result.replace(TOKEN_PATTERN, "REDACTED-EXAMPLE-TOKEN");

  return result;
}

function listFiles(rootPath: string): string[] {
  // Deliberately not caught: a missing root path (a typo'd or moved
  // --check target) must fail the guard loudly rather than silently
  // resolving to an empty file list and vacuously passing.
  const stats = statSync(rootPath);

  if (!stats.isDirectory()) return [rootPath];

  const files: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let entryStats: ReturnType<typeof statSync>;
      try {
        entryStats = statSync(fullPath);
      } catch {
        continue;
      }

      if (entryStats.isDirectory()) walk(fullPath);
      else files.push(fullPath);
    }
  }
  walk(rootPath);
  return files.sort();
}

export interface FileCheckResult {
  file: string;
  leaks: Leak[];
}

export function checkPaths(paths: readonly string[]): FileCheckResult[] {
  const results: FileCheckResult[] = [];
  for (const path of paths) {
    for (const file of listFiles(path)) {
      const leaks = findLeaks(readFileSync(file, "utf8"));
      if (leaks.length > 0) results.push({ file, leaks });
    }
  }
  return results;
}

function reportLeaks(results: FileCheckResult[]): void {
  for (const { file, leaks } of results) {
    for (const leak of leaks) {
      console.error(`  ${file}: [${leak.kind}] ${leak.value}`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args[0] === "--check") {
    const targets = args.slice(1);
    if (targets.length === 0) {
      console.error("Usage: sanitize-fixtures.ts --check <path...>");
      process.exit(1);
    }

    let results: FileCheckResult[];
    try {
      results = checkPaths(targets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Sanitisation guard: could not read check target(s): ${message}`);
      process.exit(1);
    }

    if (results.length > 0) {
      console.error("Sanitisation guard: sensitive content found:");
      reportLeaks(results);
      process.exit(1);
    }

    console.log(`No leaks found across ${targets.length} path(s).`);
    return;
  }

  const outIndex = args.indexOf("--out");
  const outPath = outIndex === -1 ? undefined : args[outIndex + 1];
  const inputPath = args.filter((_, i) => i !== outIndex && i !== outIndex + 1)[0];

  if (inputPath === undefined) {
    console.error("Usage: sanitize-fixtures.ts <input-path|-> [--out <output-path>]");
    process.exit(1);
  }

  const raw = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
  const sanitized = sanitize(raw);
  const leaks = findLeaks(sanitized);

  if (leaks.length > 0) {
    console.error("Sanitisation guard: residual sensitive content after sanitising:");
    reportLeaks([{ file: inputPath, leaks }]);
    process.exit(1);
  }

  if (outPath !== undefined) writeFileSync(outPath, sanitized);
  else process.stdout.write(sanitized);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
