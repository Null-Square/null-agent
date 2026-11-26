# Browser Tooling Methodology

Use browser automation when proof depends on browser security policy, rendering, DOM/runtime state, cookies/storage, user navigation, or real client protocols. Keep profiles isolated and actions evaluator-visible/reversible.

## Preconditions and Fast Applicability

Require exact in-scope origins, evaluator identity/profile, allowed actions, expected state, and screenshot/data retention rules. Default cap is twenty navigations/actions and one reversible state change.

## Surface Discovery and Prioritization

Record URL/origin, profile identity, initiator, network request, frame/window, DOM selector, storage/cookie names, console/security events, and pre/post-state. Prefer semantic selectors over coordinates.

## Safe Test Ladder

1. Open a clean isolated profile.
2. Navigate to exact authorized URL.
3. capture baseline screenshot/network/DOM.
4. Perform one ordinary evaluator action.
5. Apply one methodology mutation.
6. Verify server/DOM state and negative control.
7. Reset state and close profile.

## Variation Matrix

| Axis | Variants |
|---|---|
| profile | clean anonymous, supplied evaluator |
| context | top-level, observed frame/window |
| action | navigation, click, form, observed protocol |
| evidence | network, DOM, console, screenshot, storage name |
| viewport | only when responsive behavior matters |

## Proof Standard

Browser evidence requires exact URL/origin, profile state, action sequence, network/server or runtime effect, and control. Screenshot appearance alone is not proof when the claim is server-side.

## False Positives and Benign Lookalikes

- extensions/profile state alter behavior;
- cached pages display stale data;
- selectors can hit hidden/duplicate elements;
- animation/race changes screenshots;
- client state can diverge from server state;
- automation flags can change application behavior.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without isolated profile, evaluator credentials, stable selector/flow, or safe action. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser-native navigation, DOM, network, screenshot, and storage inspection. Fall back to manual evaluator flow only when it preserves the same profile/evidence.

## Handoffs and Duplicate Prevention

The owning browser/client methodology interprets evidence. This tool package owns reproducible interaction and artifact capture.

## Stop, Cleanup, and Data Minimization

Stop at proof/control, twenty actions, or unexpected state. Log out, close profile, clear evaluator data, and redact screenshots.

Never perform destructive actions, bypass browser security settings, or interact with non-evaluator users.

Research date: 2026-07-23

## Sources

- WebDriver Standard: https://www.w3.org/TR/webdriver2/
- Chrome DevTools Protocol: https://chromedevtools.github.io/devtools-protocol/
