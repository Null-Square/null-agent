# WebSocket Security Methodology

Use this method to validate handshake origin/authentication, message-level authorization, subscription isolation, and session revocation on observed WebSocket protocols. Do not invent operational messages.

## Preconditions and Fast Applicability

Require an observed handshake and message schema, evaluator identities/objects, one ordinary read/subscription flow, and close/cleanup behavior. Default cap: two simultaneous sockets, twenty messages, and one evaluator-owned state change when reversible.

## Surface Discovery and Prioritization

Record URL, subprotocol, cookies/tokens, `Origin`, connection parameters, server greeting, message types, correlation IDs, subscriptions, heartbeats, reconnect/resume, and session logout behavior.

Prioritize cross-origin credentialed handshakes, peer evaluator channel identifiers, message actions missing server authorization, and sockets remaining privileged after logout.

## Safe Test Ladder

1. Capture the UI’s normal socket and message sequence.
2. Reconnect with the same evaluator session and exact subprotocol.
3. Repeat from an evaluator foreign origin.
4. Compare logged-out handshake/message behavior.
5. Subscribe to owner data, then one supplied peer evaluator channel and a nonexistent channel.
6. Send one observed reversible action against evaluator data.
7. Log out/revoke the session and replay one benign message.
8. Close sockets and restore state.

Do not fuzz message types, increase subscription volume, or publish to real users.

## Variation Matrix

| Axis | Variants |
|---|---|
| origin | target, evaluator foreign |
| identity | owner, supplied peer, logged out |
| channel | owner, peer evaluator, nonexistent |
| lifecycle | new, resumed if observed, post-logout |
| message | observed read/subscription, one reversible action |
| subprotocol | exact advertised values |

## Proof Standard

Proof requires the server to deliver protected peer evaluator data, execute an unauthorized evaluator action, accept a credentialed foreign-origin flow with material effect, or retain authorization after revocation. Retain handshake, exact message, server-recognized identity/channel, controls, final state, and cleanup.

Successful upgrade, missing origin check without authenticated impact, error differences, or an echoed client message is not proof.

## False Positives and Benign Lookalikes

- a socket can upgrade before application authentication;
- public broadcast channels may be intentional;
- client-generated events can look like server delivery;
- reconnect tokens may be independently scoped;
- buffered events can arrive after logout but predate revocation;
- proxies can terminate and recreate connections.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without an observed schema, evaluator peer identity/channel, safe action, or reliable event attribution. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for origin/cookie behavior and a WebSocket-capable client for exact captured messages. Preserve ordering/timestamps. Do not use generic fuzzers as a fallback.

## Handoffs and Duplicate Prevention

Hand HTTP session lifecycle to `session-management`, cross-origin read rules for HTTP to `cors`, object authorization to `idor`, and resource limits to `resource-consumption`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced authorization failure, twenty messages, or protocol instability. Close both sockets, delete evaluator objects, and retain only minimal message fields.

Never perform destructive actions, message flooding, or delivery to non-evaluator users.

Research date: 2026-07-23

## Sources

- RFC 6455, The WebSocket Protocol: https://www.rfc-editor.org/rfc/rfc6455
- OWASP WSTG, Testing WebSockets: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/10-Testing_WebSockets
