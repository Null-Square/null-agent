# Server-Rendered XSS Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Use for reflected or stored input embedded by the server into HTML, attributes, script data, style, or URL contexts. DOM-only source/sink flows belong to `dom-xss`. Capture the raw response before browser mutation and identify the exact parser context.

Reflection, scanner labels, missing CSP, or dangerous characters are leads. A finding requires safe browser execution attributable to the server-rendered value.

## Surface Discovery and Prioritization

1. Mark reflections in raw HTML with a unique nonexecuting token (e.g. `xssCANARY123`, no metacharacters) and find every place it lands.
2. Classify context from where the token appears:
   - `<div>CANARY</div>` → HTML text node
   - `<input value="CANARY">` → quoted attribute
   - `var x = "CANARY"` → JavaScript string
   - `<a href="CANARY">` → URL/href
   - inside `<style>`/`style=` → CSS
   - not reflected → stored path or `dom-xss`
3. For stored input, identify author and viewer personas, persistence location, and cleanup path.
4. Record response `Content-Type`, `nosniff`, CSP, browser parsing, and encoding at the exact sink.

## Safe Test Ladder

1. Capture a literal marker and an encoded-delimiter control.
2. Use the smallest context-specific marker that sets only a page-local JavaScript flag.
3. Observe execution in a clean approved browser and capture raw response, DOM node, console/initiator, and flag.
4. Repeat once with a fresh marker or second clean browser profile.
5. For stored behavior, confirm from a second authorized persona and delete the test value.

Do not read cookies/storage, make network requests, navigate users, alter accounts, or exfiltrate data. Use at most six candidates per sink.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Context Breakout Ladder

Each payload sets a page-local flag (`window.__x=1`) or fires an inert `alert`/`print` marker — never a network call or credential read. Pick by context and escalate only after the canonical form is filtered.

- **HTML text:** `<script>window.__x=1</script>` → if tags stripped, `<img src=x onerror=window.__x=1>` → `<svg onload=window.__x=1>` → `<details open ontoggle=window.__x=1>`. If a filter only strips top-level tags, test comment survival `<!--<img src=x onerror=window.__x=1>-->`.
- **Quoted attribute:** break out with `" onmouseover="window.__x=1` or `' autofocus onfocus=window.__x=1 x="`. If the quote is entity-encoded, look for an unquoted attribute sink.
- **URL / href:** `javascript:window.__x=1` (still lands in some non-browser renderers and older webviews).
- **JavaScript string:** `";window.__x=1//`, `'-window.__x=1-'`, template-literal `${window.__x=1}`, or statement terminator `};window.__x=1//`.
- **CSS / style:** legacy `background:url(javascript:window.__x=1)` where an old engine or server-side CSS renderer is in scope.

## Stored XSS

- Submit a per-field marker into every persistent field: comments, profile/display names, labels, titles, descriptions, filenames.
- Trigger rendering by visiting the page that displays the stored value; high-value viewers are admin panels, notification/email previews, export previews, and audit logs rendered in the UI.
- Use a unique marker per field so you can attribute which field executed, and confirm from a second authorized viewer persona before filing.

## CSP Analysis and Bypass

- Read the CSP from the response headers, not assumptions.
- Permissive signals: `unsafe-inline`, `unsafe-eval`, or a wildcard/broad host in `script-src`.
- With an allowlisted CDN that serves JSONP, an injected `<script src="//allowed-cdn/jsonp?callback=window.__x=1">` can run under CSP.
- Under strict nonce/Trusted-Types CSP, pivot to a DOM sink fed by an attacker-controlled source (hand to `dom-xss`) rather than inline injection.
- A CSP `report-uri` blocked event with no alternate executable path is a negative control, not a finding.

## Variation Matrix

- Context: HTML text, attribute, URL, JavaScript data, CSS, comment.
- Lifecycle: reflected response, stored viewer, email/webview, generated preview.
- Encoding: raw, HTML entity, URL, JSON/JavaScript escaping.
- Browser parser: raw response versus final DOM, with extensions disabled.
- Interaction: automatic parse versus one documented test-user click/hover.
- Policy: CSP/nonces/Trusted Types as observed controls, never assumed from headers alone.

## Proof Standard

Proof is reproducible execution of a harmless page-local marker in a real browser, tied to the raw server response and contrasted with an encoded/inert control. Stored proof additionally needs persistence and an authorized distinct viewer. Reflection without execution is not proof.

## False Positives and Benign Lookalikes

1. Delimiters are entity-encoded and remain one text node.
2. JSON is served as `application/json` with `nosniff` and consumed via safe text APIs.
3. A browser extension, DevTools action, or test harness injects the executing node.
4. CSP reports a blocked attempt and no alternate executable path exists.
5. The same text appears in a code/example block intentionally and cannot break context.

## Missing Prerequisites and Blocked Behavior

Block when the approved browser is unavailable, a stored viewer persona/cleanup path is missing, or raw response attribution cannot be captured. When public registration exists, provision the second viewer persona rather than blocking. Preserve context and the exact harmless marker/control required.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP view/replay for raw context and `browser_action` for actual parsing/execution. `tooling-dalfox` may generate reflected/DOM leads at scale; a dalfox POC still gets confirmed once in `browser_action` before filing. Repository reads can establish encoder/sink placement but do not replace execution.

## Handoffs and Duplicate Prevention

DOM source/sink behavior (`document.write`, `innerHTML`, `eval`, `location.hash`, `postMessage`) goes to `dom-xss`, client messaging/trust to `client-side-trust-boundaries`, template evaluation to `ssti`, and final evidence to `validation`. Share one raw/browser evidence bundle.

## Stop, Cleanup, and Data Minimization

Delete stored markers, close browser profiles, and retain only sanitized raw response excerpts, DOM node, console evidence, CSP outcome, and page-local flag. Stop at the first deterministic context proof.

## Sources

- [OWASP WSTG - Testing for Reflected Cross Site Scripting](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/01-Testing_for_Reflected_Cross_Site_Scripting)
- [PortSwigger Web Security Academy - Cross-site scripting](https://portswigger.net/web-security/cross-site-scripting)
