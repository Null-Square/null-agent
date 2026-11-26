# OAuth 2.0 and OpenID Connect Examples

## Protocol Proof

- An authorization response generated for evaluator client A is accepted by evaluator client B despite distinct registered redirect URIs; issuer, client, state, and callback capture are retained.
- A login CSRF test omits or swaps `state`, and the relying party binds the supplied evaluator authorization response to the wrong browser session.
- A public client accepts a code at a different redirect URI because the token exchange does not enforce the original URI/PKCE binding.

## Not Findings

- Authorization code values are visible in the evaluator browser history but are single-use and promptly removed.
- An IdP supports multiple standards-compliant response modes.
- A client ID and discovery document are public.

Use only evaluator clients, identities, callbacks, and grants. Do not consent to extra scopes or test account takeover. JWT validation primitives route to `jwt-attacks`.
