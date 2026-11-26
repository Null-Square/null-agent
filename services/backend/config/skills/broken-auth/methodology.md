# Broken Authentication Methodology

Use this method to determine whether an application fails to preserve the identity and assurance level established by login, recovery, MFA, or re-authentication. It is an authentication-control test, not a credential attack.

## Preconditions and Fast Applicability

Proceed only when all of the following are available:

- written authorization for the exact application and identity flows;
- one evaluator-owned account, and a second evaluator-owned account when an identity comparison is required;
- access to the corresponding test mailbox or MFA device when recovery or MFA is in scope;
- a baseline successful and failed transaction for the same flow; and
- an agreed attempt cap that will not lock a real user out.

The default cap is five failed authentication attempts per evaluator-owned account in 30 minutes. Use a lower published application limit when one exists. Never test leaked passwords, password spraying, credential stuffing, or identities not supplied for the evaluation.

Mark the work blocked when a required test identity, reset channel, second factor, or explicit lockout authorization is missing.

## Surface Discovery and Prioritization

Build a state diagram before changing requests:

1. List primary login, alternate login, API login, SSO callback, MFA challenge, recovery, password change, logout, and high-risk re-authentication routes.
2. Record the anonymous, password-verified, MFA-verified, recovered, and logged-out states.
3. Record every cookie or token name, its issuance step, rotation event, expiry signal, and intended audience without retaining the secret value in notes.
4. Identify transitions whose output grants a higher assurance level.
5. Prioritize alternate channels and direct API routes that reach the same post-login resource.

Treat username enumeration, transport findings, CSRF, session-token structure, and OAuth protocol defects as handoffs unless they are necessary evidence for an authentication-state failure.

## Safe Test Ladder

Run one hypothesis at a time and restore the account to its baseline state between ladders.

### 1. Flow-step enforcement

- Complete the first step of a multi-step flow with the evaluator-owned account.
- Omit exactly one subsequent challenge and request one benign account page.
- Compare against a fully anonymous control and a fully completed control.
- Repeat once with a fresh session to exclude stale state.

### 2. Session transition and fixation

- Record only hashes of the pre-login and post-login session identifiers.
- Authenticate normally and verify whether the identifier rotates.
- Log out and replay the old identifier once against a read-only account page.
- Stop after the replay; do not reuse a valid logged-out token elsewhere.

No rotation is a lead. Proof requires that a pre-authentication or logged-out session remains accepted at an authenticated assurance level.

### 3. Password recovery

- Request one recovery transaction for the evaluator-owned mailbox.
- Test single use, expiry, binding to the same account, and invalidation after password change.
- For account-binding comparison, use only the second evaluator-owned account and alter one explicit account reference.
- Do not consume more than two reset messages per account in one run.

### 4. MFA and re-authentication

- Compare the same benign protected action after password-only and fully verified sessions.
- Test one alternate route or API representation for equivalent MFA enforcement.
- Test disabling MFA or changing a recovery channel only on the evaluator-owned account, then immediately restore it.
- Never attempt to guess an OTP or recovery code.

### 5. Lockout and throttling

- Use deliberately invalid passwords only for the evaluator-owned account.
- Send no more than the agreed cap, at no more than one request per second.
- Verify response, server-side counter behavior if observable, and recovery after the documented window.
- A status-code difference alone is not a lockout bypass.

## Variation Matrix

Vary one dimension per replay:

| Dimension | Controlled variants |
|---|---|
| Channel | browser, documented API, mobile/API route if separately authorized |
| State | anonymous, password verified, MFA verified, logged out |
| Session | fresh, pre-login, post-login, post-logout |
| Recovery token | unused, used once, expired by documented mechanism, wrong evaluator-owned account |
| Route form | UI transition, direct endpoint, alternate content type |
| Identity | evaluator account A, evaluator account B |

Do not combine identity changes with token-state changes in the same request; that makes the failed control ambiguous.

## Proof Standard

A finding requires a reproducible transition to an authentication or assurance state that the evaluator did not complete. Retain:

- a redacted state diagram;
- request and response evidence for anonymous, expected-success, and bypass cases;
- session-token hashes before and after the transition;
- server-visible identity or assurance evidence;
- timestamps and correlation identifiers; and
- account restoration evidence for any changed MFA or recovery setting.

Generic error differences, missing cookie flags, a token that merely remains syntactically valid, or lack of identifier rotation without authenticated reuse are leads only.

## False Positives and Benign Lookalikes

- A public profile page may intentionally be reachable without authentication.
- A session cookie can remain stable while server-side state rotates securely.
- A recovery link can show a form after use while rejecting the final change.
- A trusted-device policy can intentionally suppress MFA for a documented evaluator device.
- CDN or gateway responses can differ before the request reaches the identity service.
- A local browser session can mask a missing request token by supplying another valid credential.

Repeat with a clean client and correlate the server-recognized identity before concluding.

## Missing Prerequisites and Blocked Behavior

Return `blocked`, not a finding, when:

- no evaluator-owned account is available;
- the mailbox, second factor, or reset channel cannot be observed;
- lockout limits are unknown and the owner has not approved a cap;
- a test would alter another user’s account;
- the relevant route is out of scope; or
- the only evidence is a client-side display change.

Record the missing prerequisite, the safest next experiment, and the owner who can supply it. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for multi-step state capture and `http_payload` for one-variable replays. Use `report_note` for state maps and rejected hypotheses. Use `submit_validation_lead_outcome` for unresolved signals and `submit_validation_outcome` only after the proof standard is met.

If replay tooling cannot preserve the required cookie or redirect behavior, repeat through an isolated browser profile. Do not compensate by increasing attempts.

## Handoffs and Duplicate Prevention

- Hand session lifecycle, cookie attributes, and concurrent-session policy to `session-management`.
- Hand OAuth/OIDC protocol and redirect defects to `oauth-oidc`.
- Hand JWT construction defects to `jwt-attacks`.
- Hand cross-account object access after authentication to `idor`.
- Hand CSRF on password or MFA changes to `csrf`.

Keep this skill as primary only when the demonstrated failure is an unauthenticated or under-authenticated state transition. Link rather than duplicate evidence.

## Stop, Cleanup, and Data Minimization

Stop after the first independently reproducible bypass, at the attempt cap, or when any real-user impact is observed. Restore passwords, recovery channels, MFA settings, and test-account state. Retain token hashes and redacted exchanges, never live credentials or full secrets.

Never perform destructive actions, persistent access, denial-of-service behavior, or testing against identities that were not supplied for this evaluation.

Research date: 2026-07-23

## Sources

- OWASP Web Security Testing Guide, Authentication Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/04-Authentication_Testing/README
- OWASP WSTG, Weak Password Change or Reset Functionalities: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/04-Authentication_Testing/09-Testing_for_Weak_Password_Change_or_Reset_Functionalities
- OWASP WSTG, Multi-Factor Authentication: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/04-Authentication_Testing/11-Testing_Multi-Factor_Authentication
