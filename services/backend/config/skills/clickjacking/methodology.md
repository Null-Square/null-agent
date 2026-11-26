# Clickjacking Methodology

Use this method to prove that a protected, reversible evaluator action can be visually framed by an unauthorized origin and activated through user-interface redress. Missing headers alone are not sufficient.

## Preconditions and Fast Applicability

Require an authenticated evaluator account, a reversible action, an evaluator-controlled framing origin, and a stock browser. Default cap is three frame layouts and one completed evaluator action.

## Surface Discovery and Prioritization

Record `Content-Security-Policy` `frame-ancestors`, `X-Frame-Options`, frame-breaking code, SameSite/session behavior in a frame, confirmation/re-authentication, and final state. Prioritize one-click sensitive settings on evaluator data.

## Safe Test Ladder

1. Perform and reset the normal action.
2. Embed the target page visibly on the evaluator origin.
3. Confirm authentication and route rendering inside the frame.
4. Overlay a transparent evaluator label while keeping target controls visible during alignment.
5. Reduce opacity only enough to demonstrate alignment in recorded evidence.
6. Click once as the evaluator and verify state.
7. Restore state and repeat with a protected/denied route control.

Never conceal the frame from a non-evaluator user or deliver the page externally.

## Variation Matrix

| Axis | Variants |
|---|---|
| framing | direct frame, one nested frame when policy parsing requires |
| identity | logged-in evaluator, logged-out control |
| action | one reversible click |
| defense | CSP, X-Frame-Options, confirmation/re-auth |
| viewport | one desktop and one mobile size only when UI differs |

## Proof Standard

Proof requires successful unauthorized-origin framing, reliable visual alignment of a protected control, one evaluator click causing the intended state change, and cleanup. Header absence, frame rendering of public content, or a click that requires additional conscious confirmation is not proof of the claimed action.

## False Positives and Benign Lookalikes

- CSP can override legacy frame headers;
- authentication cookies may not be sent in the frame;
- responsive layouts can move the target;
- the framed route may be public/read-only;
- re-authentication can break the redress path;
- browser extensions can alter framing.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without an evaluator origin, reversible action, authenticated frame, or reliable state observation. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling and a local evaluator HTML page. Raw header inspection is diagnostic only. Do not deploy a public proof page.

## Handoffs and Duplicate Prevention

Hand cross-origin request forgery without framing to `csrf`, CSP-wide issues to `web-security-misconfiguration`, and action authorization to `access-control`.

## Stop, Cleanup, and Data Minimization

Stop after one reproduced click, three layouts, or any unexpected state. Restore the setting and delete the framing page/screenshots containing personal data.

Never perform destructive actions or involve non-evaluator users.

Research date: 2026-07-23

## Sources

- W3C Content Security Policy Level 3, `frame-ancestors`: https://www.w3.org/TR/CSP/
- OWASP Clickjacking Defense Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html
