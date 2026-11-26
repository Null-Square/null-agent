# OAuth/OIDC Mutation Algebra

One transaction binding changes per evaluator flow:

1. expected versus missing/swapped `state`;
2. expected versus swapped evaluator `nonce`;
3. registered redirect URI versus one owner-controlled unregistered URI;
4. PKCE verifier correct versus absent/mismatched;
5. issuer/client/audience expected versus one supplied alternate;
6. authorization code first use versus one replay control.

Cap at ten grants and revoke them. No extra scopes, real-user identities, third-party callbacks, or token replay outside the supplied clients.
