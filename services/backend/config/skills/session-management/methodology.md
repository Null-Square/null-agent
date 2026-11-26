# Session Management Methodology

Use this method to test session issuance, rotation, cookie scope, timeout, logout, concurrent-session policy, and revocation with evaluator-owned identities.

## Preconditions and Fast Applicability

Require an evaluator account, normal login/logout flow, isolated clients, and documented or observable idle/absolute timeout policy. Use hashes for session identifiers and never retain full values in reports.

Default cap: three sessions, two logout/revocation replays, and one documented timeout window.

## Surface Discovery and Prioritization

Record session cookie/token names, issuance points, pre/post-login hashes, domain/path, security attributes, privilege transitions, refresh behavior, idle/absolute expiry, logout endpoints, and device/session management views.

Prioritize reuse after logout, missing rotation at authentication or privilege change, cross-host cookie scope, and server/client timeout mismatch.

## Safe Test Ladder

1. Capture anonymous and authenticated session hashes.
2. Verify rotation at login and supplied privilege transition.
3. Open a second evaluator session and compare identifiers.
4. Log out one session and replay it once against a benign account page.
5. Test revoking the second session through the normal UI, then replay once.
6. Observe idle/absolute timeout without creating artificial traffic.
7. Verify cookie attributes and scope in a normal browser.
8. Restore account/session state.

Do not reuse tokens on other hosts or attempt token prediction.

## Variation Matrix

| Axis | Variants |
|---|---|
| lifecycle | anonymous, authenticated, elevated, logged out, revoked, expired |
| client | isolated browser A, isolated browser B |
| scope | intended host/path, observed sibling host only when in scope |
| transport | browser cookie, documented header token |
| policy | single/multiple session as documented |

## Proof Standard

Proof requires a session accepted in a state or scope where policy requires rejection, with identity evidence and matched active-session control. Missing cookie attributes are configuration findings only when the required security effect and deployment context are established. Stable identifiers alone are leads unless fixation or privilege reuse is demonstrated.

## False Positives and Benign Lookalikes

- client cookies can remain while server state is invalid;
- a public account shell can load after logout;
- load balancers can issue routing cookies unrelated to identity;
- sliding expiry can intentionally extend with activity;
- offline JWT policy may differ from server-session logout;
- local browser cache can display protected content without a network response.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when login, logout, second client, timeout duration, or server-recognized identity cannot be observed. State the missing lifecycle transition. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use isolated browser profiles for real cookie/cache behavior and `http_payload` for one replay. Use `tooling-jwt-tool` only when the session token is a JWT. Do not replace missing session isolation with manual cookie copying across uncontrolled clients.

## Handoffs and Duplicate Prevention

Hand login/MFA/recovery bypass to `broken-auth`, JWT consumer rules to `jwt-attacks`, OAuth/OIDC tokens to `oauth-oidc`, and CSRF to `csrf`. This skill owns lifecycle and session scope.

## Stop, Cleanup, and Data Minimization

Stop after one reproduced lifecycle failure, the replay cap, or unexpected account impact. Log out all evaluator sessions and retain salted hashes plus redacted metadata.

Never perform destructive actions, hijack another user session, or retain live tokens.

Research date: 2026-07-23

## Sources

- OWASP WSTG, Session Management Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Session_Management_Testing/
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
