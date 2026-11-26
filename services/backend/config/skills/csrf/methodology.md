# Cross-Site Request Forgery Methodology

Use this method to determine whether a browser can cause an authenticated, state-changing request from an untrusted origin without a user-intent control. Test only reversible actions on an evaluator-owned account.

## Preconditions and Fast Applicability

Require an authenticated evaluator account, a confirmed state-changing browser flow, a reversible test action, and an evaluator-controlled origin different from the target origin. Record whether authentication uses cookies, HTTP authentication, or an explicit bearer token.

CSRF is not applicable when the request cannot be sent by a browser, requires a secret header unavailable cross-origin, or has no ambient credential. Login CSRF and WebSocket handshake cases require their dedicated flow evidence.

Default cap: eight candidate requests per action and one state reset after every positive.

## Surface Discovery and Prioritization

Inventory POST, PUT, PATCH, and DELETE actions plus state-changing GET requests. Prioritize:

- password-independent account preference changes;
- creation or deletion of evaluator-owned objects;
- email, recovery, or MFA changes only when immediately reversible;
- administrative actions in a dedicated evaluator tenant; and
- endpoints with cookie authentication and form-compatible inputs.

Capture method, content type, cookie `SameSite` behavior, CSRF token location, `Origin`/`Referer` validation, redirects, and final state observation.

## Safe Test Ladder

1. Perform the action normally and record pre-state, request, response, and post-state.
2. Reset the state.
3. Replay with the anti-CSRF token removed while preserving all other fields.
4. Test one random token of the same shape.
5. Test token binding only with another evaluator session or action.
6. Serve a minimal form or navigation from the evaluator origin using a browser.
7. Observe final server state, not only the submission response.
8. Restore the state and repeat once with a fresh session if proof is positive.

Origin/referrer variants are tested only when the application relies on those headers. Do not weaken browser security settings or install extensions.

## Variation Matrix

| Axis | Bounded variants |
|---|---|
| request mode | form submission, top-level navigation when action uses GET |
| content type | form URL encoded, multipart only when baseline uses it |
| token | missing, random, wrong evaluator session, wrong action |
| origin signal | evaluator origin, omitted by a normal privacy/referrer policy |
| cookie state | fresh authenticated session, logged-out control |
| action | one reversible evaluator-owned state change |

JSON is testable only when the route also accepts a browser-simple representation or cross-origin policy permits the exact request.

## Proof Standard

Proof requires:

1. a normal authenticated baseline changes the evaluator-owned state;
2. a request initiated from the evaluator-controlled foreign origin carries ambient authentication;
3. the request lacks a valid user-intent token or equivalent defense;
4. the exact intended state change occurs;
5. a logged-out or invalid-token control does not change state; and
6. the state is restored.

A missing token in HTML, a `200` response, a permissive CORS header, or a cross-origin request that reaches the server without changing state is not proof.

## False Positives and Benign Lookalikes

- `SameSite` cookies can prevent credentials on the actual cross-site path.
- A response may say success while a later transaction rejects the change.
- A token can be optional because strict origin validation is effective.
- A public or idempotent action may have no security impact.
- Browser extensions or disabled security features can create non-realistic requests.
- A preflighted request may be blocked before credentials are sent.

Use a stock browser profile and verify server-side post-state.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when no evaluator account, safe reversible action, foreign evaluator origin, or state observation is available. Record the exact request and needed safe action. Never use another user’s state as a substitute.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for real credential and `SameSite` behavior. Use `http_payload` only for token enforcement differentials, not as proof of browser exploitability. Use `report_note` for token/origin matrices and cleanup.

If the foreign origin cannot be hosted, use an owner-provided local evaluation page; otherwise block browser proof.

## Handoffs and Duplicate Prevention

- Hand cookie lifecycle to `session-management`.
- Hand cross-origin read behavior to `cors`.
- Hand login or MFA state transition to `broken-auth`.
- Hand WebSocket origin enforcement to `websockets`.
- Hand cross-account object authorization to `idor`.

CSRF owns absence of user intent for an ambiently authenticated action. Do not duplicate the action’s authorization flaw.

## Stop, Cleanup, and Data Minimization

Stop after one independent browser proof, eight candidates, or any unexpected user impact. Restore evaluator state and remove the foreign-origin page. Retain redacted cookie metadata, not cookie values.

Never perform destructive actions, alter a non-evaluator account, or leave security settings changed.

Research date: 2026-07-23

## Sources

- OWASP WSTG, Testing for Cross-Site Request Forgery: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Session_Management_Testing/05-Testing_for_Cross_Site_Request_Forgery
- OWASP Cross-Site Request Forgery Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Fetch Standard, CORS protocol and credentials: https://fetch.spec.whatwg.org/
