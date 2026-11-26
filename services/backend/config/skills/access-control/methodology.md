# Function-Level Access Control Methodology

Use this skill for vertical, role, tenant, and function authorization. Object-specific ownership belongs to `idor`; property binding belongs to `mass-assignment`.

## Preconditions and Fast Applicability

Require a documented or observed protected function, supplied evaluator roles, and a reversible operation or read-only canary in an isolated tenant. Build the expected role-to-function matrix before replay.

Default cap is twelve requests per function and one state-changing proof on evaluator-owned data.

## Surface Discovery and Prioritization

Map UI actions to exact API routes, methods, content types, and server-recognized roles. Prioritize administrative or tenant-management functions reachable from a lower evaluator role, alternate API/mobile routes, and inconsistent enforcement between methods.

## Function-Level Bypass Reference

When the lower/peer role is denied on the canonical route, the hypothesis is that enforcement is incomplete somewhere. Try one bypass at a time with the lower evaluator role and compare against the allowed-role and anonymous controls:

- **Method swap:** call the same path with `GET`/`POST`/`PUT`/`PATCH`/`DELETE` and with a method-override header (`X-HTTP-Method-Override: PUT`); enforcement is often bound to one verb.
- **Path-equivalence:** trailing slash, uppercase, `%2e`/`%2f` encoding, `..;/`, a `.json`/`.xml` suffix, or a double slash — a front proxy may authorize on a normalized path the backend routes differently.
- **Routing-header override:** `X-Original-URL`, `X-Rewrite-URL`, `X-Original-Host` pointing at the protected path while requesting an allowed one.
- **Alternate surface:** the same function on its API, mobile, admin, or GraphQL equivalent, which frequently skips the UI's gateway check.
- **Role/tenant assertion:** replay with `X-Role`, `X-Tenant-ID`, `X-Account-ID`, or a body `role`/`orgId` field set to a privileged/peer value to test client-trusted authorization.

A bypass that lets the expected-denied role reach the protected function is the proof; stop there and do not exercise the privileged function against real data or roles.

## Safe Test Ladder

1. Execute the function with its allowed evaluator role.
2. Replay unchanged with the lower/peer evaluator role.
3. Compare anonymous access.
4. Test one observed alternate route, method, or content type at a time.
5. For state change, use an owner-provided canary field/object and verify authoritative post-state.
6. Repeat once with fresh sessions and restore state.

Do not guess administrative actions or change real privileges.

## Variation Matrix

| Axis | Variants |
|---|---|
| role | allowed control, lower role, tenant peer, anonymous |
| route | UI route, observed API/mobile equivalent |
| method | baseline, one advertised alternate |
| representation | documented content types |
| state | fresh session, post-role-change session when supplied |
| operation | read-only, reversible evaluator canary |

## Proof Standard

Proof requires the expected-denied evaluator role to complete or receive the protected function, while allowed and anonymous/nonexistent controls establish the policy boundary. State changes require authoritative post-state and cleanup. Hidden UI, route existence, different errors, or a `200` without protected effect is not proof.

## False Positives and Benign Lookalikes

- the function may intentionally be shared across roles;
- a gateway may return a generic shell before backend denial;
- stale privileged cookies can contaminate the lower-role session;
- UI labels may not represent server roles;
- an accepted job can later be denied;
- method overrides can normalize to the same authorized route.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without supplied role identities, a policy expectation, safe operation, or authoritative result. Record the role/function matrix cell that cannot be tested. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use isolated browser profiles to establish roles and `http_payload` for exact replays. Use `report_note` for the matrix. If sessions cannot be separated reliably, stop rather than infer from response differences.

## Handoffs and Duplicate Prevention

Hand object ownership to `idor`, property writes to `mass-assignment`, authentication state to `broken-auth`, and workflow invariants to `business-logic`. This skill owns whole-function authorization.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced unauthorized function, twelve requests, or unexpected state. Restore evaluator data and retain role labels/token hashes rather than credentials.

Never perform destructive actions or alter a non-evaluator role/object.

Research date: 2026-07-23

## Sources

- OWASP API5:2023 Broken Function Level Authorization: https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/
- OWASP WSTG, Bypassing Authorization Schema: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/02-Testing_for_Bypassing_Authorization_Schema
