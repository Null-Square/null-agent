# Software Supply-Chain Examples

## Corroborated Risks

- The production lockfile resolves a package to an untrusted HTTP registry and the build configuration uses that lockfile unchanged.
- A CI workflow executes an unpinned third-party action on untrusted pull-request content with a documented write token; preserve the exact trigger and permissions without running it.
- A deploy artifact's SBOM contains a vulnerable package in the active runtime path, and source/import evidence establishes reachability.

## Reject or Downgrade

- A vulnerable package exists only in a test/dev dependency excluded from production.
- A package name resembles an internal dependency, but every registry is scoped and authenticated.
- A secret-shaped value is a fixture explicitly marked invalid.

Never publish dependency names, claim packages, trigger CI, or use discovered tokens. Missing build/deploy provenance makes the case a source lead.
