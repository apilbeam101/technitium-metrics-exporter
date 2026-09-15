# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately, using
[GitHub Security Advisories](../../security/advisories/new) for this
repository. Do not open a public issue for a security report.

We aim to acknowledge new reports promptly and to disclose fixed
vulnerabilities responsibly once a patched release is available.

## Supported versions

Only the latest minor release line is supported with security fixes until
v1.0.0 ships. This section will be updated once a formal support window is
established.

## Least-privilege API token

This exporter is read-only against the Technitium DNS Server HTTP API by
design — see [docs/DESIGN.md](docs/DESIGN.md) §6.3 for how that is enforced
structurally rather than by convention. To set up a scoped token with the
minimum permissions the exporter needs:

1. Create a dedicated user. Never `admin`.
2. Grant a group `View` on `Dashboard` and `Zones`, **and `View` on each
   individual zone** — the zone list is filtered per zone, so a token missing
   `View` on any zone will silently under-report (see
   [docs/DESIGN.md](docs/DESIGN.md) §3.2.4 and §5.3).
3. Only if the cluster collector is wanted, add `Administration: View`, and
   be aware that this grant also exposes users, groups and sessions to that
   token.
4. Create a non-expiring API token once (`POST /api/user/createToken`), and
   store it as a secret — never in a config file, never committed.

The exporter never needs, accepts, or stores a password.

## Handling of secrets

- No secret (API token, TLS key material) is ever written to a log, error
  message, metric, configuration summary, or `--dump-raw` diagnostic dump.
  See [docs/DESIGN.md](docs/DESIGN.md) N5 and §3.2.10.
- Configuration is environment-variable only; there is no on-disk config file
  format for the exporter itself to accidentally leak a token into.
