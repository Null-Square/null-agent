# Schemathesis Tooling Methodology

Use Schemathesis for bounded schema-derived API checks after the schema, target, authentication, operation safety, and generation limits have been reviewed. Generated cases are leads until reproduced by the owning methodology.

## Preconditions and Fast Applicability

Require an in-scope OpenAPI/GraphQL schema hash, exact base URL, evaluator auth, operation allowlist, safe state/reset, examples/seeds, rate limit, and output path. Exclude unknown state-changing operations.

Default: five examples per selected operation, one worker, five requests/second, sixty-second run.

## Surface Discovery and Prioritization

Review operation methods/tags, parameters/bodies, auth schemes, links/stateful workflows, response schemas, examples, and destructive semantics. Select only explicit operations.

## Safe Test Ladder

1. Validate schema offline.
2. Run one documented example.
3. Generate positive schema-conformant cases.
4. Generate bounded negative cases for one parameter/property.
5. Run stateful links only on evaluator-owned reversible objects.
6. Save failing example, seed, curl-like reproduction, response hash.
7. Manually reproduce through owning skill.

## Variation Matrix

| Axis | Variants |
|---|---|
| generation | positive, one negative dimension |
| operation | explicit allowlist |
| auth | supplied evaluator context |
| state | stateless, reviewed link on evaluator fixture |
| check | status/schema/content-type documented checks |

## Proof Standard

Tool success is a reproducible minimized example and raw response tied to schema hash/config/seed. A generated failure, unexpected status, schema mismatch, or crash is a lead, not a validated vulnerability.

## False Positives and Benign Lookalikes

- stale schemas produce expected mismatches;
- undocumented valid responses fail schemas;
- rate limiting affects generated cases;
- cleanup failures contaminate stateful tests;
- auth examples expire;
- server errors may be generic validation behavior.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without reviewed schema, safe operation allowlist, evaluator auth/state, or caps. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Pin configuration/seed, one worker, explicit checks, cassette/artifact output, and operation filters. Do not use all-endpoint defaults on a live target.

## Handoffs and Duplicate Prevention

`api-enumeration` owns schema/operation inventory; class skills own validation. Schemathesis owns generated case provenance/minimization.

## Stop, Cleanup, and Data Minimization

Stop at first minimized candidate per root behavior, request/time cap, or instability. Delete evaluator objects and redact auth.

Never perform destructive actions, uncontrolled generation, or unreviewed stateful workflows.

Research date: 2026-07-23

## Sources

- Schemathesis Documentation: https://schemathesis.readthedocs.io/
- Hypothesis Documentation: https://hypothesis.readthedocs.io/
