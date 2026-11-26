# Mass Assignment and Object Property Authorization Methodology

Use this method to determine whether a create or update endpoint binds client-supplied properties that the evaluator role is not allowed to write. Test only evaluator-owned objects and reversible, owner-approved canary fields.

## Preconditions and Fast Applicability

Require an evaluator identity, an evaluator-owned object, a normal create/update request, a way to read authoritative post-state, and a property-authorization expectation. A second evaluator role is useful for role differentials but is not a substitute for object ownership controls.

The owner should supply a harmless protected canary property such as `review_label` in a disposable tenant. If the only candidate would change privilege, billing, ownership, moderation, or another user’s object, dynamic proof is blocked unless an isolated test fixture makes it harmless and reversible.

Default cap: ten candidate fields per object, sent one at a time.

## Surface Discovery and Prioritization

Build a field provenance table from:

- normal request bodies;
- response-only properties;
- published schemas and generated clients;
- source DTO/model/serializer definitions;
- GraphQL input types;
- PATCH merge behavior; and
- create versus update routes.

Classify fields as client-writable, server-managed, computed, immutable, or unknown. Prioritize response-only fields that source or schema maps to the same bound model.

## Safe Test Ladder

1. Create or reset an evaluator-owned object and record its full allowed state.
2. Change one documented writable property and verify the normal update path.
3. Add one nonexistent property to observe unknown-field handling.
4. Add one owner-provided protected canary property with a unique marker.
5. Read authoritative state through a separate GET or database-backed test view.
6. Repeat once with the canary omitted to confirm it does not change through another process.
7. Test one nested or alternate route only when it binds the same object.
8. Restore the object and verify the marker is gone.

Do not submit a bulk list of guessed security-sensitive field names.

## Variation Matrix

| Axis | Bounded variants |
|---|---|
| operation | create, full update, partial update |
| field location | root, one observed nested object |
| representation | JSON, form only when both are documented |
| value | unique inert string, boolean only for a supplied canary |
| role | normal evaluator role, supplied control role |
| state evidence | immediate response, independent object read |
| schema behavior | reject unknown, ignore unknown, bind allowed list |

Each replay changes one field and preserves the baseline body.

## Proof Standard

Proof requires:

1. the role is not authorized to write the chosen property;
2. the candidate request includes that property on an evaluator-owned object;
3. the server persists or acts on the exact marker;
4. an independent read confirms authoritative post-state;
5. an unknown-property or omitted-property control does not explain the result; and
6. cleanup restores state.

Echoing a field, returning `200`, documenting a property, or exposing a response-only property without a write is not mass-assignment proof.

## False Positives and Benign Lookalikes

- Serializers can echo unknown fields without persistence.
- Eventual consistency can show an old marker from a prior test.
- A field may be intentionally writable for the evaluator role.
- A response projection can rename a different internal property.
- The UI can hide a documented API capability.
- A PATCH route can ignore the field while a background job changes state for another reason.

Use a unique marker, independent read, and permission expectation from schema/source/owner.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when no evaluator-owned object, authoritative state read, property-authorization expectation, safe protected canary, or cleanup path exists. Source evidence can remain a lead but cannot establish dynamic impact alone.

State the missing field fixture and intended harmless effect. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for one-field request differentials and `http_differential` when available for baseline/candidate comparison. Use repository reads for DTO, binding, and allow-list traces. Browser tooling is only needed to create normal object state.

If the API omits the property from responses, use an owner-provided test audit view; do not infer persistence from the update response.

## Handoffs and Duplicate Prevention

- Hand cross-object identifier access to `idor`.
- Hand whole-function role enforcement to `access-control`.
- Hand GraphQL transport/schema specifics to `graphql`.
- Hand workflow or price/entitlement invariants to `business-logic`.
- Hand source-only mapping to `source-aware-whitebox`.

This skill owns unauthorized property binding. File one root cause per binding policy, listing affected routes as variants.

## Stop, Cleanup, and Data Minimization

Stop at first independently confirmed protected-property write, ten fields, or unexpected state. Restore or delete the evaluator object and retain only redacted field names and marker evidence.

Never perform destructive actions, change real privilege/billing/ownership, or touch a non-evaluator object.

Research date: 2026-07-23

## Sources

- OWASP API Security Top 10, API3:2023 Broken Object Property Level Authorization: https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/
- OWASP Mass Assignment Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- CWE-915, Improperly Controlled Modification of Dynamically-Determined Object Attributes: https://cwe.mitre.org/data/definitions/915.html
