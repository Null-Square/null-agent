# JavaScript Surface Analysis Methodology

Use this skill to analyze deployed JavaScript and published source maps for routes, API operations, client-side data flow, public configuration, and credential-like candidates. It is primarily offline analysis and does not validate discovered secrets or vulnerabilities.

## Preconditions and Fast Applicability

Require an in-scope web origin, asset URLs observed from that origin, an artifact budget, and rules for authenticated bundles. Default caps are fifty scripts, 100 MiB total uncompressed content, one source-map probe per observed script, and no requests to discovered third-party or internal URLs.

Download only assets the evaluator session is authorized to access. Redact bearer values from captured request headers.

## Surface Discovery and Prioritization

Create an asset manifest containing URL, response hash, size, source page, build identifier, map reference, and authentication state. Prioritize:

- entry chunks and route manifests;
- API client modules and GraphQL documents;
- lazy chunks loaded by ordinary navigation;
- source maps explicitly linked by assets;
- service-worker code and cache lists; and
- configuration objects embedded at bootstrap.

Classify extracted values as route, operation, parameter, storage key, public configuration, credential-like candidate, or third-party integration reference.

## Concrete Extraction Reference

Run these offline against downloaded, in-scope bundles (never against discovered third-party/internal hosts). Each match is a lead with file/offset provenance; classify, do not use.

- **Endpoint/route strings:** extract quoted paths and `fetch`/`axios`/`XMLHttpRequest` targets — e.g. `rg -o "['\"]/(api|v[0-9]|graphql|internal)[^'\"]*" *.js`. Feed confirmed paths to `api-enumeration`/`graphql`.
- **Credential-like patterns (redact on capture):** `(api[_-]?key|apikey|secret|password|token|auth)["'\s]*[:=]["'\s]*["'][^"' ]{8,}["']`; AWS `AKIA[0-9A-Z]{16}`; JWT `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.`; Google `AIza[0-9A-Za-z_-]{35}`; Stripe `sk_live_[0-9A-Za-z]{24,}`.
- **Token handling (drives session testing):** `(localStorage|sessionStorage)\.(setItem|getItem)` filtered to `token|auth|jwt|session`; `Authorization.*Bearer`; refresh logic `refresh.?token|/auth/refresh|/token/refresh`.
- **Hidden surface:** internal/staging hostnames, GraphQL endpoint hints, and `wss?://` WebSocket endpoints referenced in code.
- **Tooling:** `tooling-gitleaks` for candidate classification only (no remote validation); source maps (§ ladder) to recover original module/route names.

## Safe Test Ladder

1. Capture the page’s actual script requests in a clean browser profile.
2. Download each confirmed asset once and verify content type/size.
3. Follow its declared source-map URL only when same-origin or explicitly in scope.
4. Extract route and operation strings with file/offset provenance.
5. Trace selected client inputs through parsers to network or DOM sinks.
6. Corroborate a discovered API path with one read-only request only when it stays in scope.
7. Classify credential-like strings offline; do not attempt to use them.
8. Deduplicate identical chunks by hash.

Minified text matches remain candidates until surrounding code establishes their role.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| build artifact | entry, route chunk, worker, manifest, source map |
| application state | anonymous, supplied evaluator session |
| evidence | static string, constructed value, observed request |
| data flow | URL/storage/message source to network/DOM/config sink |
| environment | deployed origin and build identifier |
| candidate status | observed, statically referenced, uncorroborated |

Do not execute extracted snippets outside an isolated offline parser.

## Proof Standard

A surface record requires an asset hash and file/offset or source path. A confirmed route or operation also requires an observed request, router declaration, or safe same-origin corroboration. A credential-like candidate requires value type, location, surrounding use, and redacted hash; validity is explicitly untested.

This skill creates inventory and leads. A string containing a secret pattern, dangerous sink name, or hidden route is not by itself a finding.

## False Positives and Benign Lookalikes

- source maps can include test fixtures and dead code;
- minified identifiers can resemble keys or tokens;
- public client identifiers can be intentionally non-secret;
- API examples and localhost URLs can ship in documentation code;
- route strings can belong to a third-party library;
- old chunks can remain on a CDN after deployment.

Correlate with the active build and surrounding code before handoff.

## Missing Prerequisites and Blocked Behavior

Return partial coverage when assets exceed limits, maps require unavailable authorization, dynamic chunks need an unreachable feature flag, or minification prevents a defensible trace. Record exact missing navigation or source artifact.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for asset provenance and lazy loading, `file_read`/text search for offline analysis, and parsers that produce file offsets. Use `tooling-gitleaks` only for candidate classification with no remote validation.

If a source map is absent, analyze the minified chunk and preserve offsets; do not brute-force map names beyond the one declared convention.

## Handoffs and Duplicate Prevention

- Hand SPA route/state mapping to `spa-recon`.
- Hand API operations to `api-enumeration` or `graphql`.
- Hand DOM source/sink hypotheses to `dom-xss`.
- Hand non-XSS browser trust boundaries to `client-side-trust-boundaries`.
- Hand credential-like disclosure to `information-disclosure` for safe validation.

This skill owns asset provenance and static trace evidence. Downstream findings link those artifacts.

## Stop, Cleanup, and Data Minimization

Stop at fifty assets, 100 MiB, two passes with no new active-build surface, or any out-of-scope URL. Remove live headers and user data from artifacts; retain hashes and minimal code excerpts.

Never perform destructive actions, use discovered credentials, or contact discovered hosts that are not already verified in scope.

Research date: 2026-07-23

## Sources

- OWASP WSTG, JavaScript Execution: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/02-Testing_for_JavaScript_Execution
- OWASP WSTG, Excessive Data Exposure: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/12-API_Testing/03-Testing_for_Excessive_Data_Exposure
- Source Map Revision 3 Proposal: https://sourcemaps.info/spec.html
