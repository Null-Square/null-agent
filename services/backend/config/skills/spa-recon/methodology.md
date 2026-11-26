# Single-Page Application Reconnaissance Methodology

Use this reconnaissance method to map client routes, API calls, lazy chunks, state transitions, and real-time transports from an authorized SPA. It discovers testable surfaces without invoking privileged or destructive actions.

## Preconditions and Fast Applicability

Require:

- an in-scope SPA origin;
- permission for passive browser instrumentation and ordinary evaluator navigation;
- evaluator credentials only when authenticated routes are explicitly in scope; and
- a workspace for storing redacted route and asset inventories.

Default limits are two navigation passes, one anonymous and one evaluator-authenticated; fifty fetched JavaScript assets; and one read-only connection to each observed real-time endpoint. Do not brute-force route names or send invented action messages.

## Surface Discovery and Prioritization

Capture a clean browser session and inventory:

- initial HTML, script tags, module preload links, and source-map references;
- client-side routes and route guards;
- fetch/XHR/GraphQL requests with method, path template, and content type;
- WebSocket, server-sent event, and long-poll endpoints;
- storage keys by name and classification, without retaining credential values;
- service workers, manifests, and cache strategies;
- lazy chunks loaded by ordinary navigation; and
- feature flags or environment labels exposed to the client.

Prioritize endpoints reachable through ordinary flows and routes whose client guard is not mirrored by an observed server response.

## Safe Test Ladder

### 1. Passive load capture

Open the start route in a fresh profile. Record network requests and assets until the page is idle. Do not click state-changing controls.

### 2. Ordinary route navigation

Follow visible navigation once. Record route transitions, newly loaded chunks, and API calls. For authenticated coverage, repeat with the supplied evaluator account.

### 3. Static asset analysis

Search fetched JavaScript and source maps for route literals, API base paths, operation names, public configuration, and real-time endpoint constructors. Do not treat a string literal as a live endpoint until an observed request or safe `GET`/metadata request corroborates it.

### 4. Client/server guard comparison

For a route hidden from the current evaluator role, request the route shell or its observed read-only data endpoint once without altering identifiers. A client redirect plus server authorization failure is expected. Do not attempt role changes here.

### 5. Real-time transport metadata

Reproduce only the observed connection handshake with the same evaluator identity. Record negotiated protocol and server greeting. Subscribe only to a channel the normal UI already subscribes to, and send no invented command or mutation message.

### 6. Service-worker and cache review

Record registered scope, cached resource classes, update behavior, and whether authenticated API responses appear in a shared cache. Clear only the isolated profile’s storage after capture.

## Variation Matrix

| Axis | Variants |
|---|---|
| identity | anonymous, supplied evaluator account |
| route source | visible navigation, router table, lazy chunk |
| API evidence | observed request, static literal plus safe corroboration |
| transport | fetch/XHR, GraphQL, WebSocket, events, long poll |
| build artifact | main bundle, lazy chunk, source map when published |
| application state | clean profile, ordinary post-login state |

Do not combine role, identifier, and transport mutations during reconnaissance.

## Proof Standard

A recon note must tie each surface to at least one artifact:

- browser network request and initiator;
- source file plus line or minified offset;
- router declaration;
- observed real-time handshake; or
- service-worker cache entry.

A vulnerability finding is not produced by this skill. Client-only guards, exposed route names, public build configuration, and hidden UI elements become leads for their primary validation skills.

## False Positives and Benign Lookalikes

- Bundles often contain dead code and routes removed from the deployed backend.
- Source maps can reference development-only hosts.
- Prefetched chunks do not prove a user can reach the feature.
- A WebSocket URL may be a third-party telemetry endpoint.
- API strings can be examples or test fixtures.
- Service-worker caches can be partitioned per profile despite similar names.

Mark evidence as observed, statically referenced, or uncorroborated.

## Missing Prerequisites and Blocked Behavior

Return partial coverage with a blocker when authentication, a route feature flag, published assets, or source-map access is missing. State which inventory class is incomplete and the ordinary user action needed to expose it.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for navigation, initiator stacks, storage-name inspection, and real-time handshake capture. Use `file_read` and text search for downloaded assets. Use `http_payload` only for a single read-only corroborating request already derived from an observed artifact.

If bundles are too large, prioritize route tables, API client modules, and lazy-chunk manifests instead of indiscriminate extraction.

## Handoffs and Duplicate Prevention

- Hand API path inventories to `api-enumeration`.
- Hand object references to `idor`.
- Hand DOM data flows to `dom-xss`.
- Hand GraphQL operations to `graphql`.
- Hand real-time authorization leads to `websockets`.
- Hand service-worker cache policy to `web-cache-security`.
- Hand framework-specific artifacts to the matching framework skill.

This skill owns the SPA surface map. Downstream skills reference its artifact identifiers and add only validation evidence.

## Stop, Cleanup, and Data Minimization

Stop after both navigation passes, fifty assets, one handshake per observed endpoint, or any unexpected state change. Close the isolated profile and remove cached credential values from artifacts. Retain route templates and hashes instead of full tokens or user data.

Never perform destructive actions, submit invented real-time actions, bypass identity controls, or retain live session secrets.

Research date: 2026-07-23

## Sources

- WHATWG Fetch Standard: https://fetch.spec.whatwg.org/
- WHATWG HTML, Web Sockets: https://html.spec.whatwg.org/multipage/web-sockets.html
- W3C Content Security Policy Level 3: https://www.w3.org/TR/CSP/
- OWASP Web Security Testing Guide, Client-side Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/
