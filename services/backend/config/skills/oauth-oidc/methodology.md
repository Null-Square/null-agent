# OAuth 2.0 and OpenID Connect Methodology

Use this method to validate authorization-code/OIDC transaction binding, redirect matching, PKCE, state/nonce, issuer/client mix-up defenses, token audience/type, and account linking with evaluator-owned clients and identities.

## Preconditions and Fast Applicability

Require a registered in-scope client, evaluator identity, captured successful flow, expected authorization server/issuer, exact redirect URI, and ability to start fresh browser transactions. A second evaluator identity is required for account-linking swaps.

Default cap: eight authorization transactions, two code exchanges per hypothesis, and no token use outside its registered resource server.

## Surface Discovery and Prioritization

Map authorization, token, metadata, JWKS, userinfo, end-session, and client callback endpoints; client identifier; redirect URIs; response type/mode; PKCE method; state/nonce; issuer; scopes; and token consumers.

Prioritize code injection/substitution, redirect URI matching, PKCE binding, login CSRF, mix-up, account-linking identity binding, refresh rotation, and exact issuer/audience checks.

## Safe Test Ladder

1. Capture one complete fresh flow and hash transaction values.
2. Replay a code after successful exchange; it must fail.
3. Exchange a code with a wrong verifier in the same evaluator client; it must fail.
4. Start two evaluator transactions and swap only state, nonce, or code one at a time.
5. Test one minimally altered redirect URI without using an external recipient.
6. Compare issuer/client binding only between owner-supplied evaluator configurations.
7. For account linking, use identities A and B and stop before any irreversible merge.
8. Revoke/logout evaluator tokens and verify documented lifecycle.

Do not create open internet redirect endpoints or expose tokens in evidence.

## Variation Matrix

| Axis | Variants |
|---|---|
| transaction | fresh A, fresh B, replayed |
| binding | state, nonce, PKCE verifier, issuer, client |
| redirect | exact registered, one minimally different evaluator URI |
| identity | evaluator A, evaluator B |
| token | code, access, ID, refresh by intended purpose |
| client | only supplied registered evaluator clients |

## Proof Standard

Proof requires an authorization, authentication, account-linking, or token result bound to the wrong evaluator transaction/client/issuer/identity, or acceptance of a redirect outside exact registered policy. Retain redacted request sequence, hashes, server-recognized identity, and negative control.

Metadata exposure, public client IDs, missing optional parameters without exploitability, or a decodeable token is not proof.

## False Positives and Benign Lookalikes

- browser retries can show a callback for an already-consumed code;
- clients may intentionally support multiple exact redirects;
- state may be protected inside an opaque signed transaction;
- nonce is OIDC-specific while OAuth-only flows can use other binding;
- a token endpoint error can occur before verifier evaluation;
- account chooser UI does not prove the linked subject.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without registered evaluator clients, fresh transactions, second identity for linking, or authoritative client/server logs. Do not substitute third-party clients. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for redirects/cookies and `http_payload` for exact token exchanges. Use offline token inspection only. If automation loses transaction state, repeat in isolated manual profiles rather than weakening controls.

## Handoffs and Duplicate Prevention

Hand JWT consumer validation to `jwt-attacks`, session lifecycle to `session-management`, generic open redirects to `open-redirect`, and resource authorization to `access-control`/`idor`. This skill owns protocol transaction binding.

## Stop, Cleanup, and Data Minimization

Stop at one independent binding failure, eight flows, or any cross-identity uncertainty. Revoke evaluator grants and delete local token copies; retain hashes and redacted parameters.

Never perform destructive actions, use tokens at unintended services, or link non-evaluator accounts.

Research date: 2026-07-23

## Sources

- RFC 9700, OAuth 2.0 Security Best Current Practice: https://www.rfc-editor.org/rfc/rfc9700
- OpenID Connect Core 1.0: https://openid.net/specs/openid-connect-core-1_0.html
- RFC 7636, PKCE: https://www.rfc-editor.org/rfc/rfc7636
