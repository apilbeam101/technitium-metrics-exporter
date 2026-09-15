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
2. **A newly created non-admin user already has `View` on every section
   except `Administration` and `Settings` — this is default behaviour.** That
   default includes `Zones` at the section level, but does not extend to
   individual zones: the zone list is filtered per zone, so `View` must still
   be granted on each zone the exporter should see (see
   [docs/DESIGN.md](docs/DESIGN.md) §3.2.4 and §5.3).
3. Because most sections default to granted, and this exporter only reads
   `Dashboard` and `Zones`, explicitly restrict `View` on every section it
   does not use: `Cache`, `Allowed`, `Blocked`, `Apps`, `DnsClient`,
   `DhcpServer`, `Logs`. None of this default access is `Modify`/`Delete`, but
   it's a wider read exposure than granting only `Zones` implies. `Settings`
   and `Administration` are already denied by default and need no
   restricting.
4. Only if the cluster **configuration-detail** metrics are wanted (heartbeat
   and refresh intervals, config sync time), add `Administration: View`, and
   be aware that this grant also exposes users, groups and sessions to that
   token. Basic cluster peer state needs no grant at all (see
   [docs/DESIGN.md](docs/DESIGN.md) §5.6).
5. Create a non-expiring API token once (`POST /api/user/createToken`), and
   store it as a secret — never in a config file, never committed.

The exporter never needs, accepts, or stores a password.

## Handling of secrets

- No secret (API token, TLS key material) is ever written to a log, error
  message, metric, configuration summary, or `--dump-raw` diagnostic dump.
  See [docs/DESIGN.md](docs/DESIGN.md) N5 and §3.2.11.
- Configuration is environment-variable only; there is no on-disk config file
  format for the exporter itself to accidentally leak a token into.
