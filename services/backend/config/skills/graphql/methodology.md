# GraphQL Security Methodology

Use this method to map a confirmed GraphQL endpoint and validate resolver authorization, field exposure, mutation controls, transport policy, and bounded query limits. GraphQL presence or introspection alone is inventory.

## Preconditions and Fast Applicability

Require a confirmed endpoint, one observed valid operation, evaluator identities/objects for authorization tests, and a request/complexity cap. Default limits are twenty queries, maximum depth five, maximum ten selected fields, maximum two aliases, and no subscription beyond one observed evaluator channel.

State-changing mutations run only on evaluator-owned disposable objects with a cleanup operation.

## Surface Discovery and Prioritization

Build schema knowledge from observed client operations first, published schema second, and one standard introspection request only when authorized. Record operation type, root field, arguments, return fields, directives, transport, auth context, and resolver/object ownership.

Prioritize object and field authorization, mutation input binding, hidden sensitive fields, batching/alias enforcement, and CSRF-compatible transports. Hand generic injection in resolver arguments to its primary class.

## Safe Test Ladder

1. Replay one observed query and record normalized data/errors.
2. Query only `__typename` to confirm GraphQL semantics when needed.
3. Request one additional field at a time on an evaluator-owned object.
4. Compare owner, peer evaluator, and nonexistent object controls.
5. For a mutation, change one allowed field, reset, then test one owner-provided protected canary field.
6. Compare JSON POST with only the alternate transports the endpoint advertises.
7. Test depth/field/alias limits just below and just above documented thresholds, never beyond the caps.
8. For subscriptions, reproduce the UI’s own subscription and compare only evaluator-owned channel identifiers.

Do not enumerate sequential identifiers, batch credential attempts, or request large nested graphs.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| operation | query, mutation, observed subscription |
| identity | anonymous, owner, supplied peer/control role |
| object | owner object, peer evaluator object, nonexistent |
| field | normal, one sensitive candidate, one protected canary input |
| transport | JSON POST, advertised GET/form transport |
| query shape | one alias, two aliases; depth around documented limit |
| schema source | observed, published, authorized introspection |

Each request isolates one resolver or policy.

## Proof Standard

A finding requires an unauthorized field value, object, mutation effect, or subscription event on evaluator-owned test data; or objective acceptance beyond a documented safe query limit. Retain the exact operation, variables, identity, owner/nonexistent controls, response paths, final state, and cleanup.

Schema names, suggestions, introspection, verbose errors, and differing GraphQL error text are leads unless they disclose sensitive schema/data contrary to policy.

## False Positives and Benign Lookalikes

- field-level nulls can be intended authorization;
- GraphQL returns HTTP `200` for application errors;
- aliases can duplicate response labels without duplicate resolver effects;
- cached persisted queries can differ from ad hoc operations;
- public profile fields can be intentionally shared;
- a gateway can enforce limits before resolver execution.

Interpret `data` and `errors` together and verify authoritative state.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when valid operations, evaluator identities/objects, mutation cleanup, or safe limit thresholds are unavailable. Do not compensate with broad schema guessing or high-cost queries.

Record the missing operation/fixture. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/network capture for real operations and `http_payload` for bounded query replays. Parse schema and responses offline. Use `tooling-schemathesis` only when its GraphQL support and limits are explicitly configured.

If introspection is disabled, use observed operations and source/schema artifacts; do not brute-force field suggestions.

## Handoffs and Duplicate Prevention

- Hand object authorization to `idor` when transport is incidental.
- Hand property binding to `mass-assignment`.
- Hand CSRF browser proof to `csrf`.
- Hand SQL/NoSQL/command injection in arguments to their class owners.
- Hand resource behavior beyond bounded limit controls to `resource-consumption`.

GraphQL owns resolver/field/operation and GraphQL transport controls. File one root cause per resolver policy.

## Stop, Cleanup, and Data Minimization

Stop at first reproduced policy failure, twenty queries, or any latency/availability signal. Delete evaluator mutation objects and terminate subscriptions. Retain redacted variables and minimal response fields.

Never perform destructive actions, high-complexity queries, credential batching, or access to non-evaluator private objects.

Research date: 2026-07-23

## Sources

- GraphQL Specification: https://spec.graphql.org/
- PortSwigger Web Security Academy, GraphQL API Vulnerabilities: https://portswigger.net/web-security/graphql
- OWASP GraphQL Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html
