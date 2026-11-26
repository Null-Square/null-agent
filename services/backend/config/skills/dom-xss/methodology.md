# DOM XSS Methodology

Use this method to prove a browser-executed source-to-sink path with a nonce-only canary. Static sink appearance, reflection, and DOM insertion without execution are leads.

## Preconditions and Fast Applicability

Require an in-scope page, an attacker-controllable browser source, an observed or statically traced DOM sink, and an isolated evaluator browser profile. Use a random nonce and a canary that only sets an evaluator-owned DOM attribute or in-memory variable.

Default cap: six context mutations for one source/sink pair, two page loads per candidate, and no external callback or data access.

## Surface Discovery and Prioritization

Map sources such as URL components, web messages, storage, referrer, and server-provided client data to sinks that interpret HTML, script, URLs, or event handlers. Record transformations, sanitizer calls, framework rendering boundaries, and Trusted Types/CSP state.

Prioritize a complete dynamic trace. A sink name in a minified bundle without a reachable source is not applicable.

## Safe Test Ladder

1. Load a clean page and verify the nonce is absent.
2. Put a plain alphanumeric marker in one source.
3. Observe its exact DOM or debugger path and rendering context.
4. Test one context-breaking character set without executable content.
5. Use the minimum nonce-only canary appropriate to that context.
6. Verify browser execution by the canary’s exact DOM/in-memory effect.
7. Repeat with a fresh nonce and a sanitized/encoded negative control.
8. Reload clean and verify the effect is gone.

Do not read cookies, storage values, page data, or make network requests from the canary.

## Variation Matrix

| Axis | Bounded variants |
|---|---|
| source | query, fragment, message, storage, server data |
| sink context | HTML text, attribute, URL, script string, framework escape hatch |
| transformation | decode, parse, concatenate, sanitize |
| browser state | clean profile, ordinary evaluator navigation |
| defense | framework escaping, sanitizer, CSP, Trusted Types |
| proof | nonce-only DOM attribute or variable |

One source/sink/context tuple is one hypothesis.

## Proof Standard

Proof requires a trace from attacker-controlled source to executable sink plus two fresh nonce executions in a normal browser, a non-executing matched control, and the exact affected origin. DOM reflection, node creation, scanner taint, or static flow without execution is not proof.

Document CSP and Trusted Types as impact modifiers, not substitutes for safe source-to-sink handling.

## False Positives and Benign Lookalikes

- text insertion can resemble HTML in developer tools;
- framework escaping can preserve characters safely;
- an extension can modify the page;
- dead code can contain a reachable-looking sink;
- a sanitizer can allow markup but remove executable attributes;
- CSP can block one proof while another browser policy is the actual reason.

Use a clean profile, runtime trace, and negative control.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when the source needs an unavailable user flow, the page cannot run in an isolated browser, policy forbids the harmless canary, or a trace cannot be attributed. Retain the static path as a lead.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for breakpoints, DOM inspection, event observation, and canary proof. Use `file_read` for bundle/source-map traces. Use `http_payload` only to prepare server data that the browser later processes.

If automation changes execution timing, reproduce manually in the same isolated profile rather than adding payload complexity.

## Handoffs and Duplicate Prevention

- Hand server-reflected/stored contexts to `xss`.
- Hand web-message/origin issues without script execution to `client-side-trust-boundaries`.
- Hand prototype source behavior to `prototype-pollution`.
- Hand client route/asset inventory to `spa-recon` or `js-surface-analysis`.

This skill owns browser source-to-executable-sink proof. Link server storage or transport evidence rather than duplicate it.

## Stop, Cleanup, and Data Minimization

Stop at two nonce proofs plus control, six mutations, or unexpected navigation/state. Close the isolated profile and remove evaluator-created storage/state.

Never perform destructive actions, collect browser data, or deliver the canary to non-evaluator users.

Research date: 2026-07-23

## Sources

- PortSwigger Web Security Academy, DOM-based XSS: https://portswigger.net/web-security/cross-site-scripting/dom-based
- OWASP DOM based XSS Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
- W3C Trusted Types: https://www.w3.org/TR/trusted-types/
