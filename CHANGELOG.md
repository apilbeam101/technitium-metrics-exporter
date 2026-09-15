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
