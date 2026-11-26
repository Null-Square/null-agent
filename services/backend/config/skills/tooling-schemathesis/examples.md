# Schemathesis Tooling Examples

## Bounded Property Checks

- From a supplied OpenAPI operation, vary one documented identifier across evaluator owner, peer synthetic, and nonexistent values.
- Check that malformed enum and boundary values yield documented client errors without server state change.
- Replay a single generated failure with a fixed seed and minimized example.

## Exclusions

- Stateful fuzzing of destructive methods without a disposable environment.
- Schema-wide execution with default concurrency against production.
- Reporting every `5xx` without repeatability, request minimization, and impact.

Pin operation IDs, phases, seed, example count, deadline, and authentication context. Export the minimal reproducer and hand its primitive to the owning skill.
