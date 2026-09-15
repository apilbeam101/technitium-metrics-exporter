# Contributing

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run check    # supply-chain guards: no native addons, pack allowlist, license allowlist
```

Every change should leave `npm run typecheck && npm run lint && npm test &&
npm run build && npm run check` green. See
[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for the current build phase,
module layout, and shared primitives to reuse rather than reimplement.

## Design changes

If a change alters what the exporter exposes or why, update
[docs/DESIGN.md](docs/DESIGN.md) in the same pull request. If it only changes
how something gets built, [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) is
the right place instead. Keep the two separate — see the note at the top of
each file.

## Publishing scope

This project is self-contained. Nothing committed — code, comments, docs,
commit messages, fixtures, manifests, dashboards, or alert rules — should
reference any other project, prior art, or private infrastructure, including
as justification for a design choice. Example values use `example.com`,
`192.0.2.0/24`, `2001:db8::/32`, and generic node names (`dns-a`, `dns-b`,
`dns-c`).

## Commit sign-off (DCO)

Every commit must include a `Signed-off-by` trailer certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s -m "your message"
```

This adds a line like:

```
Signed-off-by: Your Name <you@example.com>
```

Once CI exists (see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) Phase 13),
pull requests with unsigned commits will fail the DCO check there. Until then,
sign off anyway — it's the same requirement, just not yet machine-enforced.

## Reporting a vulnerability

See [SECURITY.md](SECURITY.md). Do not open a public issue for a security
report.
