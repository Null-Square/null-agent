# Session Management Examples

## Confirmed

- The evaluator changes its password, but the pre-change session remains valid after the documented invalidation window and still reads the evaluator's private canary.
- Logout invalidates only the browser cookie while the copied evaluator token continues to authorize the same low-risk profile read.
- A session identifier is unchanged across anonymous-to-authenticated transition and a second evaluator browser supplied the pre-login value.

## Not Confirmed

- A cookie lacks `Secure` on an HTTP-only local test deployment.
- A token remains visible client-side but the server has invalidated it.
- Two requests receive the same load-balancer cookie while application sessions differ.

Use evaluator accounts only, cap lifecycle transitions at six, and revoke all created sessions. Route token-claim issues to `jwt-attacks`.
