# Source-Aware Whitebox Examples

## Valid Correlation

- Route registration, middleware order, controller, and ORM query form a complete path from an evaluator request to a missing tenant predicate; runtime proof on synthetic records confirms it.
- A scanner flags an unsafe sink, but dataflow shows the input is a compile-time constant. Close as a false positive with path evidence.
- Deployed commit metadata and a runtime fingerprint match the reviewed source revision; a one-variable evaluator request corroborates the source hypothesis.

## Insufficient

- A vulnerable function is unreferenced.
- A route is behind a feature flag whose active value is unknown.
- Source and runtime versions differ.

Do not turn code access into permission to run scripts, use secrets, or modify deployments. Hand the proven primitive to its specialist and keep source provenance here.
