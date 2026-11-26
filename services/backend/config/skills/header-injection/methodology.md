# HTTP Header Injection Methodology

Use this method to determine whether user input creates or changes response headers, splits a response, or alters a security-relevant header. Proof uses inert evaluator markers and isolated cache keys.

## Preconditions and Fast Applicability

Require an input reflected or transformed into a response header, a raw response capture path, and a nonce URL. Default cap is eight encoding variants and no active browser script or shared cache entry.

## Surface Discovery and Prioritization

Map redirects, download filenames, cookies, custom metadata, proxy-added headers, and log-to-response flows. Identify every decode layer and whether the application/server rejects control characters.

## Safe Test Ladder

1. Capture normal and alphanumeric-marker responses.
2. Test literal control characters only when the client can represent them safely.
3. Test once-encoding for each observed decoder.
4. Attempt to create one inert header `X-B1-Marker: <nonce>`.
5. Verify raw header boundaries and a syntax-neutral encoded control.
6. For splitting, use a nonce URL and an inert text body marker only.
7. Repeat once and expire any isolated cache key.

## Variation Matrix

| Axis | Variants |
|---|---|
| sink | redirect, filename, cookie, custom header |
| encoding | literal, once per observed decoder |
| delimiter | CRLF pair, single controls as rejection controls |
| transport | normal supported HTTP version |
| effect | inert added header, isolated body boundary |

## Proof Standard

Proof requires the raw response parser to recognize an evaluator marker as a separate attacker-controlled header or response, with baseline and neutral controls. Visible encoded characters, log injection, generic server error, or a header value containing text without a new boundary is not proof.

## False Positives and Benign Lookalikes

- clients can render escapes rather than send bytes;
- proxies can normalize or add headers;
- developer tools can fold header display;
- redirects can decode only in the browser;
- HTTP/2 forbids some field forms and gateways translate them;
- cache artifacts can predate the nonce.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when raw bytes, decoder attribution, or isolated response/cache observation is unavailable. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use raw-capable `http_payload` capture and byte/hex evidence. Browser tools are secondary. Do not use a cache as proof unless the key is evaluator-isolated.

## Handoffs and Duplicate Prevention

Hand cache persistence to `web-cache-security`, request framing to `http-request-smuggling`, host use to `host-header-attacks`, and browser execution to `xss`.

## Stop, Cleanup, and Data Minimization

Stop at one inert header proof, eight variants, or parser instability. Expire nonce responses and retain minimal raw bytes.

Never perform destructive actions, inject active content, or affect shared responses.

Research date: 2026-07-23

## Sources

- OWASP WSTG, HTTP Response Splitting: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/15-Testing_for_HTTP_Response_Splitting
- RFC 9110, Field Values: https://www.rfc-editor.org/rfc/rfc9110
