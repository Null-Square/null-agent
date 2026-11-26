# Client-Side Trust Boundary Methodology

Use this skill for `postMessage` origin/data validation, DOM clobbering, browser storage trust, dangling markup, reverse tabnabbing, XSSI, resource manipulation, and HTML/CSS injection that does not execute script. DOM script execution belongs to `dom-xss`.

## Preconditions and Fast Applicability

Require an observed browser channel and isolated evaluator profiles/origins. Use nonce-only data and evaluator-owned pages. Default cap is eight messages/DOM mutations and no access to real user storage.

## Surface Discovery and Prioritization

Map message senders/listeners and origin checks, named DOM lookups, storage keys and consumers, opener relationships, resource URL constructors, JSON/script endpoints, and HTML/CSS sinks. Prioritize cross-origin actions or protected evaluator data.

## Safe Test Ladder

1. Capture the normal channel/event.
2. Send a plain nonce from the expected source.
3. Repeat from an evaluator foreign origin or wrong window.
4. Change one message field or DOM name collision.
5. Observe only a benign evaluator canary action/attribute.
6. Test storage with a disposable key and clean profile.
7. Verify opener isolation through an evaluator destination.
8. Reset the profile.

## Variation Matrix

| Axis | Variants |
|---|---|
| channel | message, storage, opener, DOM name, resource URL, JSON/script |
| origin | expected, evaluator foreign |
| source window | parent, child, unrelated evaluator window |
| data | valid shape, one altered field, nonce |
| sink | benign DOM/resource/navigation canary |

## Proof Standard

Proof requires an untrusted browser source to cause an unauthorized evaluator action, data exposure, navigation/resource change, or security-relevant DOM effect with origin/source controls. Mere message receipt, HTML reflection, storage presence, or a missing attribute is not proof.

## False Positives and Benign Lookalikes

- listeners may validate data after receipt;
- public messages can be intentional;
- browser extensions alter DOM/storage;
- named properties differ across browsers;
- `noopener` can be applied implicitly;
- JSON endpoints may require credentials that cross-origin script cannot send.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without an evaluator foreign origin, safe channel effect, or isolated browser. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for event provenance, window relationships, DOM, and storage. Use source analysis for listeners/consumers. Raw HTTP does not prove browser trust behavior.

## Handoffs and Duplicate Prevention

Hand script execution to `dom-xss`, CORS reads to `cors`, framing to `clickjacking`, WebSockets to `websockets`, and prototype changes to `prototype-pollution`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced boundary failure, eight mutations, or unexpected navigation. Close profiles and clear evaluator storage.

Never perform destructive actions, collect user data, or send messages to non-evaluator windows.

Research date: 2026-07-23

## Sources

- HTML Standard, Cross-document messaging: https://html.spec.whatwg.org/multipage/web-messaging.html
- OWASP HTML5 Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
