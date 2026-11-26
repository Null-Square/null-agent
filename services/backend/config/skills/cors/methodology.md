# Cross-Origin Resource Sharing Methodology

Use this method to determine whether a browser can read protected evaluator data from an unauthorized origin. Header reflection without a browser-readable sensitive response is not proof.

## Preconditions and Fast Applicability

Require a protected read-only endpoint, evaluator account/data, a normal browser request, and an evaluator-controlled foreign origin. Record credential mode, preflight requirements, and expected trusted origins.

Default cap: ten origin variants for one endpoint and no state-changing action.

## Surface Discovery and Prioritization

Map `Access-Control-Allow-Origin`, credential allowance, exposed headers, preflight methods/headers, caching (`Vary: Origin`), redirects, and origin parsing. Prioritize credentialed endpoints returning evaluator-private data.

## Safe Test Ladder

1. Fetch same-origin and record the protected evaluator response.
2. Fetch from the approved trusted origin if one exists.
3. Fetch from a random evaluator foreign origin.
4. Test one subdomain/suffix parsing variant and the `null` origin only when a real sandboxed/file context is in scope.
5. Observe response readability in a stock browser.
6. Repeat with logged-out and public-data controls.
7. Check preflight/cache behavior with a fresh nonce.

Do not host payloads on unrelated domains or read another user’s data.

## Variation Matrix

| Axis | Variants |
|---|---|
| origin | same, trusted, evaluator foreign, one parser variant, null when applicable |
| credentials | include, omit |
| request | simple GET, baseline preflighted read |
| response | private evaluator data, public control |
| cache | fresh origin A, fresh origin B |

## Proof Standard

Proof requires the foreign evaluator page to receive a browser-resolved response containing protected evaluator data with ambient credentials, while logged-out/public controls establish sensitivity. Headers alone, a server request that the browser blocks, wildcard on public content, or a failed preflight is not proof.

## False Positives and Benign Lookalikes

- developer tools show blocked response headers the page cannot read;
- public APIs may intentionally allow every origin;
- credential omission can return a public representation;
- CDN caches can replay headers without the body;
- browser extensions can bypass normal CORS;
- `Origin` reflection may occur only on error pages.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without a foreign evaluator origin, browser session, sensitive evaluator response, or expected origin policy. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for final proof and `http_payload` for header/preflight diagnostics. A raw HTTP client cannot establish browser readability.

## Handoffs and Duplicate Prevention

Hand cross-origin state changes to `csrf`, WebSocket handshakes to `websockets`, and endpoint authorization to `idor`/`access-control`. CORS owns cross-origin read enforcement.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced browser read, ten origins, or unexpected state. Remove the evaluator page and retain redacted response excerpts.

Never perform destructive actions or collect non-evaluator data.

Research date: 2026-07-23

## Sources

- WHATWG Fetch Standard, CORS protocol: https://fetch.spec.whatwg.org/
- PortSwigger Web Security Academy, CORS: https://portswigger.net/web-security/cors
