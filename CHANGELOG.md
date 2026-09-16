# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project scaffold: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `biome.json`, `LICENSE` (Apache-2.0), `README.md`, `CONTRIBUTING.md` (with DCO), `CODE_OF_CONDUCT.md`, `SECURITY.md`, `example.env`
- GitHub workflows scaffolding: `dependabot.yml`, issue and PR templates
- .gitignore, .gitattributes, .gitleaks.toml, .dockerignore
- Three supply-chain guard scripts (`check-no-native-addons`, `check-pack-allowlist`, `check-license-compound`) with comprehensive unit tests
- Aggregate `npm run check` command for pre-commit hygiene
- Placeholder `src/index.ts` and placeholder test structure
- Hand-authored API fixtures covering every documented Technitium HTTP API hazard: session/get variants (v15+, pre-v15, invalid-token, error with stackTrace), metrics/text in both upstream spelling conventions, comprehensive zones/list spanning all seven zone types with every conditional-field combination, cluster/state with never-sentinel timestamps and Unknown peer state, stats/get with full protocol/response-type coverage and sparse-array edge case
- Fixture-sanitisation tool (`scripts/sanitize-fixtures.ts`) with `--check` guard mode and comprehensive leak detection (IP addresses, domains, token-shaped strings) including RFC 3849/RFC 4291 boundary cases and arpa reverse-zone false-positive avoidance
- Fixture and sanitiser unit tests under `test/unit/fixtures/` and `test/unit/scripts/`
- Configuration module (`src/config/`): type definitions, validation, env-var loading with override, secret redaction, deep-freeze immutability, per-target configuration keying
- HTTP client primitives (`src/http/`): injectable clock for testability, PollErrorReason taxonomy, read-only path allowlist (DESIGN.md §6.3), undici Agent wiring for per-target TLS/CA-bundle, wall-clock-budgeted retry with exponential backoff, GET-only HTTP client that classifies HTTP status honestly rather than trusting it, comprehensive retry and timeout edge-case test coverage including real TLS handshake tests with self-signed certificate
- JSON envelope classifier (`src/api/envelope.ts`) handling the HTTP-200-on-auth-failure quirk (DESIGN.md §3.2.1) and the flat-vs-wrapped shape difference between session/get and other endpoints
- .NET timestamp parser (`src/api/time.ts`) handling the never-sentinel and UTC-default suffix-less timestamps
- Test support: fake clock with event-loop simulation (`test/support/fake-clock.ts`), test-only self-signed TLS certificate and private key for exercising `http/agent.ts` TLS wiring
- Session parser (`src/api/session.ts`) extracting version, node identity, domain, cluster-initialized flag, permission map, and cluster peer inventory (name/type/state/lastSeen)
- State-set classification primitive (`src/metrics/state-set.ts`) for enum values (`absent`/`recognized`/`unrecognized`)
- Session collector (`src/metrics/session-collector.ts`, `session-metrics.ts`) with `technitium_up` derived from actual call outcome, permission gating for disabled or permission-denied collectors, honest `up` set last on success and first on failure (N6), and stale cluster peer series cleared on failed cycles
- Cluster peer inventory metrics (`technitium_cluster_node_state`, `technitium_cluster_node_last_seen_timestamp_seconds`, `technitium_cluster_nodes`) sourced from `session/get` without extra permission or call
- Server info metrics (`technitium_server_version_info`, `technitium_server_version_supported`, `technitium_server_domain_info`) and cluster-initialized flag (`technitium_cluster_initialized`) from session preflight
- Permission gating: one warning per collector on transition to skipped/failed state, `technitium_collector_success{collector}` set to 0 while gated/failing and removed (not 1) on permission restore
- Native metrics parser and collector (`src/api/native-text.ts`, `src/metrics/native-metrics.ts`, `src/metrics/native-collector.ts`): parses Technitium's `GET /api/dashboard/metrics/text` endpoint (Prometheus text format subset), maps upstream's dual counter-name spellings (e.g. `total_queries`/`queries_total`) to stable `technitium_`-prefixed names, converts `start_time` from milliseconds to seconds, handles missing fields as genuinely absent (vs. stale on failed poll), rejects negative values as parse error
- Absent-vs-frozen semantics: named counters missing from successful poll become absent series; fields from failed poll cycles remain frozen at their last reported value (DESIGN.md §5.4)
- Shared `technitium_collector_success` gauge across session and native collectors via `collectorSuccess` accessor
- First golden exposition-text fixture (`test/fixtures/golden/native-lifetime-counters.txt`) for byte-for-byte metric serialization tests

### Fixed

- `SessionCollector` permission-transition logic now removes stale `technitium_collector_success` set-to-0 only once on permission restore, avoiding race with concurrent writes from native collector
- Deduplicated error-reason classification via new shared `reasonOfError()` helper in `src/http/errors.ts`
