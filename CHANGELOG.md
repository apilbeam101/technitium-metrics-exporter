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
