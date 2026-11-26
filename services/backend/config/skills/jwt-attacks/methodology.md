# JSON Web Token Validation Methodology

Use this method to test whether a JWT consumer enforces the intended signature algorithm, key source, issuer, audience, lifetime, token type, and revocation state. All claim changes use evaluator-owned identities and reversible test resources.

## Preconditions and Fast Applicability

Require a token issued through an authorized evaluator flow, its consumer endpoint, expected issuer/audience/type, and a benign authenticated action. Obtain two evaluator identities when claim-to-identity binding is tested.

Do not perform password or key guessing. Do not send tokens to third-party decoders. If the token is encrypted, opaque, or not consumed by the tested endpoint, record not applicable or hand off to the owning identity protocol.

Default cap: twelve token variants for one consumer and no more than two refresh cycles.

## Surface Discovery and Prioritization

For each token class, record:

- where it is issued and consumed;
- header fields and declared algorithm;
- issuer, audience, subject, token type, issue/expiry times, and identifier;
- key-discovery method and expected key identifier;
- access versus refresh purpose;
- cookie or authorization-header transport; and
- logout/revocation behavior.

Prioritize consumers that accept the same token across services or token types, because audience and type confusion are more likely there.

## Safe Test Ladder

1. Replay the unmodified token against one benign evaluator resource.
2. Change one payload claim without re-signing; it must fail.
3. Change the header algorithm declaration without creating a valid signature; it must fail.
4. Remove or corrupt the signature segment; it must fail.
5. Test issuer, audience, and token-type binding one at a time with legitimately issued evaluator tokens.
6. Test expiry using an already expired test token or owner-controlled short lifetime; do not manipulate system clocks on shared hosts.
7. Test logout/revocation by revoking the evaluator token and replaying it once.
8. Test key URL or key identifier handling only with an evaluator-owned key endpoint and inert key material.

Algorithm-confusion testing requires an owner-provided test key pair and disposable consumer. Without it, retain configuration evidence as a lead.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| integrity | original, payload changed, signature missing/corrupt |
| algorithm | configured value, mismatched declaration |
| claims | issuer, audience, subject between evaluator identities, type |
| time | valid, expired, not-yet-valid using issued test tokens |
| lifecycle | active, logged out/revoked, refreshed |
| key reference | known key id, unknown key id, evaluator key URL |
| consumer | intended service, one documented alternate service |

Never cross-product variants; each request isolates one validation rule.

## Proof Standard

A finding requires a modified, expired, revoked, wrong-audience, wrong-issuer, wrong-type, or wrong-evaluator token to be accepted as an authenticated identity by the consumer. Retain:

- hashes of baseline and candidate tokens;
- decoded non-secret header/claim differences;
- expected rejection control;
- consumer-observed evaluator identity;
- request/response and state evidence; and
- key-source evidence when applicable.

Decoding a JWT, weak-looking claims, a public key identifier, or a library version is not proof.

## False Positives and Benign Lookalikes

- A frontend may decode and display a token that the backend rejects.
- Grace periods can be documented and bounded.
- A refresh token can be accepted only at the refresh endpoint by design.
- Multiple audiences can be intentionally configured for one resource server.
- Logout may revoke a server session while a separately issued access token remains valid by documented policy.
- A gateway can authenticate before the downstream service sees the candidate.

Confirm the identity at the actual resource consumer.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when legitimate evaluator tokens for the needed issuer/audience/type are unavailable, revocation cannot be observed, or confusion testing lacks test keys and a disposable consumer. Do not fabricate another tenant’s identity.

Record the exact missing token class or key fixture. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `tooling-jwt-tool` or local offline decoding for token structure and hashes. Use `http_payload` for exact consumer replays. Use browser tooling only when token transport depends on browser storage or cookies.

If token material cannot be retained, store salted hashes and redacted claims while performing replay in the isolated session.

## Handoffs and Duplicate Prevention

- Hand authorization after valid authentication to `idor` or `access-control`.
- Hand OAuth/OIDC issuance and redirect behavior to `oauth-oidc`.
- Hand cookie/session lifecycle to `session-management`.
- Hand login/MFA bypass to `broken-auth`.

This skill owns JWT consumer validation. One token accepted by multiple consumers should produce one root-cause finding with affected consumers listed.

## Stop, Cleanup, and Data Minimization

Stop at first independently reproduced acceptance failure, twelve variants, or consumer instability. Revoke evaluator tokens and delete local token copies. Keep token hashes and redacted claims.

Never perform destructive actions, guess signing secrets, or test tokens belonging to other users.

Research date: 2026-07-23

## Sources

- RFC 7519, JSON Web Token: https://www.rfc-editor.org/rfc/rfc7519
- RFC 8725, JSON Web Token Best Current Practices: https://www.rfc-editor.org/rfc/rfc8725
- OWASP WSTG, Testing JSON Web Tokens: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Session_Management_Testing/10-Testing_JSON_Web_Tokens
