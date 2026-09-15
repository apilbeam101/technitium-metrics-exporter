// D§3.1 / D§6.3: the upstream API accepts GET for destructive endpoints (e.g.
// zone delete), so a GET-only client is not by itself read-only — the request
// path must be constrained to exactly this set as well. A frozen array
// (rather than a Set, which Object.freeze does not stop .add() on) makes
// D§6.3's "frozen allowlist" true at runtime, not just by convention.
const ALLOWED_PATHS: readonly string[] = Object.freeze([
  "/api/user/session/get",
  "/api/dashboard/metrics/text",
  "/api/zones/list",
  "/api/dashboard/stats/get",
  "/api/admin/cluster/state",
]);

export function assertPathAllowed(path: string): void {
  if (!ALLOWED_PATHS.includes(path)) {
    throw new Error(`request path "${path}" is not in the read-only allowlist`);
  }
}
