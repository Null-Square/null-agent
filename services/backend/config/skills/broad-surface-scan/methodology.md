# Broad Surface Mapping Methodology

Use this skill at the start of a fresh scope, after material scope change, or when retained inventory is too shallow to support the requested assessment. The goal is a provenance-backed map of the attackable application—not a quick fingerprint and not a vulnerability-template pass.

## Preconditions and Fast Applicability

Require a current authorization snapshot, verified namespace or CIDR roots, explicit exclusions, the execution network, and a durable artifact directory. A verified domain covers its apex and descendants downward. Redirects, CNAMEs, shared infrastructure, and discovered IPs do not expand authority.

The runtime mission/request/time budgets are the quantitative boundary. There is no customer rate or blast-window field to interpret. Respect target stability, back off on overload signals, and prefer phase-sized scanner jobs with structured output.

For a domain-only authorization, keep activity hostname-bound. Do not turn a resolved shared address into a host-wide network target. Broad port/service scanning requires an authorized CIDR or other explicit network root.

Never perform destructive actions. Never convert blocked or ambiguous work into a finding.

## Surface Discovery and Prioritization: Coverage Ledger

Maintain one ledger with source and last observation for:

- authorized roots and exclusions;
- passive hostname candidates and wildcard controls;
- resolved in-scope hostnames;
- HTTP/TLS origins by scheme and port;
- redirect observations, including denied foreign destinations;
- pages, routes, parameters, forms, uploads, and static assets;
- API prefixes, operations, specifications, GraphQL/gRPC/WebSocket indicators;
- JavaScript bundles, source maps, route constants, and client-side API calls;
- anonymous, synthetic-authenticated, and role-specific reachable surface;
- technology fingerprints with raw indicators and confidence; and
- blocked or intentionally untested surface.

Do not let a coarse service/technology fingerprint stand in for route, identity, or operation coverage. Freshness is meaningful only for the concrete surface represented by the retained evidence.

## Safe Test Ladder

Proceed from passive namespace evidence to scoped origin confirmation, static/link mapping, rendered and authenticated mapping, and only then targeted active discovery. Each phase consumes the prior phase's confirmed inventory, checks exclusions again, and stops at foreign infrastructure or material side effects.

## Phase 1 — Normalize the Authorized Boundary

1. Normalize roots and exclusions and record the authorization digest.
2. Separate domain namespaces from CIDR roots; do not infer one from the other.
3. Resolve supplied URLs into exact scheme, host, port, and seed path.
4. Record connected repositories and evaluator access material as discovery aids, never as scope expansion.
5. Create a random-label DNS control for each root before trusting subdomain resolution.

Any candidate outside the namespace is an observation only. Do not follow it with attack traffic or forward cookies, credentials, or authorization headers.

## Phase 2 — Descendant and Origin Discovery

For domain roots:

1. Collect passive DNS/certificate candidates with `subfinder` and available certificate sources.
2. Normalize, deduplicate, and discard look-alike suffixes such as `notexample.com` for `example.com`.
3. Compare candidate DNS/body behavior with random-label controls to detect wildcard DNS and default virtual hosts.
4. Confirm only authorized descendants with `httpx` or an equivalent structured origin probe.
5. Preserve alternate live ports and schemes as separate origins; do not collapse `https://api.example.com` and `http://api.example.com:8080`.

For CIDR roots, use `network-recon` for bounded port/service discovery, then promote confirmed HTTP/TLS services into the web-origin ledger. Domain-only roots do not authorize arbitrary scanning of their resolved IPs.

## Phase 3 — Static and Link-Based Web Mapping

For every confirmed origin:

1. Capture the root, seed path, status, headers, title, body fingerprint, and redirect location without automatic cross-namespace following.
2. Crawl same-origin links, forms, scripts, manifests, and response-discovered URLs with `katana` or browser capture.
3. Extract high-value route families: authentication/signup, account/profile, administration, APIs, uploads/downloads, search, export/import, billing/order workflows, callbacks/webhooks, and debug/health/spec routes.
4. Enumerate parameters from query strings, forms, JSON bodies observed in client traffic, and client-side route construction.
5. Fetch and inspect JavaScript/source maps when they are directly referenced, then hand deep client analysis to `js-surface-analysis` or `spa-recon`.

If a server returns one SPA shell for many paths, count one shell—not many endpoints. Switch to rendered browser navigation, client route extraction, and observed API traffic.

## Phase 4 — Dynamic and Authenticated Surface

Static crawling is not complete black-box discovery for a modern application. Under bounded PoC:

1. Use public signup when available to create only the minimum synthetic identities needed for mapping and later authorization checks.
2. Use supplied evaluator credentials when present and applicable to the exact host.
3. Navigate menus, tabs, forms, client-side routers, lazy-loaded pages, and ordinary safe workflows in a real browser.
4. Capture XHR/fetch/GraphQL/WebSocket traffic and correlate it with UI states.
5. Map pre-auth versus post-auth routes and, when multiple synthetic roles exist, map role-specific differences.
6. Create a minimal evaluator-owned record when the application requires one to reveal CRUD routes; record cleanup and avoid external side effects.

Normal interactive form actions and scoped POST/PUT/PATCH requests are allowed for synthetic setup and evaluator-owned state. Do not delete, purchase, message real users, trigger fulfillment, or create other irreversible/third-party effects.

## Phase 5 — Targeted Content and Interface Discovery

Run content discovery only after an origin/prefix is confirmed and only where it can add a missing class of surface:

- `ffuf` for bounded common paths, backup/spec/debug names, or a confirmed API prefix;
- OpenAPI/Swagger/Postman/AsyncAPI discovery around observed documentation paths;
- GraphQL endpoint confirmation after a client or response indicator;
- WebSocket/gRPC/SOAP indicators for protocol-specific handoff;
- framework-specific discovery only after corroborated fingerprints.

Use body hashes, normalized titles, status/length clusters, redirect targets, and random nonexistent paths to suppress soft-404 and wildcard results. A non-404 alone is not an endpoint.

## Phase 6 — Saturation and Adaptive Follow-Up

After each phase, ask which material surface family remains unknown. Continue only with the next method likely to resolve that gap. Examples:

- passive hosts found but no origins confirmed → origin confirmation;
- repeated SPA shell → browser/client/API pivot;
- auth route found but no post-auth traffic → provision/use evaluator identity;
- API prefix found but no operations → `api-enumeration`;
- upload form found → record route, fields, content types, and hand off;
- identical wildcard responses → change fingerprinting strategy instead of expanding the wordlist;
- WAF/challenge wall → use browser state, alternate safe transport, or record the precise blocker.

Stop when two different applicable discovery methods add no new high-value origin, route family, parameter family, identity state, or interface—or when the mission budget is exhausted. Do not stop merely because one scanner completed successfully.

## Variation Matrix

Track coverage across root/descendant, scheme/port, anonymous/authenticated/role states, static/rendered/client-traffic sources, web/API/protocol interfaces, and current/observed-version paths. Vary only axes supported by a confirmed signal and retain which method covered each cell; empty cells drive the next bounded probe rather than blind expansion.

## Proof Standard

Inventory proof is an observable DNS answer, certificate, service response, HTTP exchange, rendered route, browser network event, specification operation, or client reference tied to an exact authorized target and timestamp. Guessed candidates remain unconfirmed.

This skill files leads and coverage, not validated vulnerabilities. Admin paths, version strings, exposed ports, and scanner template matches require their owning validation skill.

## False Positives and Benign Lookalikes

- wildcard DNS and catch-all TLS virtual hosts;
- CDN/default reverse-proxy pages across unrelated names;
- parked or expired hosts;
- stale certificates and dead JavaScript routes;
- soft-404 pages and universal SPA shells;
- foreign redirects and third-party identity/payment/analytics hosts;
- headers injected by intermediaries rather than the application.

Use random-label controls, body fingerprints, exact namespace decisions, fresh-session confirmation, and independent indicators.

## Missing Prerequisites and Blocked Behavior

Record the exact missing surface and prerequisite: DNS egress, current authorization, browser capability, public signup, evaluator account, protocol tooling, or private-runner access. A provisionable synthetic prerequisite is work to perform, not a permanent blocker. An actually blocked or prohibited prerequisite does not become a negative test result.

## Tool Selection and Fallback

Use structured scanner outputs under `/workspace/.artifacts/`, wait for managed jobs, ingest artifacts, and read the generated digest before raw drill-down. Typical ownership:

- `subfinder` for passive descendant candidates;
- `httpx` for origin confirmation and coarse fingerprints;
- `katana` for link/script crawl;
- `ffuf` for bounded content discovery;
- browser action/network capture for rendered and authenticated surface;
- `network-recon` plus `naabu`/`nmap` only for authorized network roots.

Do not duplicate ingested inventory manually. Preserve raw evidence for conflicting observations and parser repair.

## Handoffs and Duplicate Prevention

- `api-enumeration` owns operation inventories.
- `spa-recon` and `js-surface-analysis` own deep client behavior.
- `network-recon` owns CIDR/service coverage.
- framework skills own specialized platform enumeration.
- vulnerability-class skills own hypotheses and proof.

Maintain one canonical origin/route ledger and link downstream missions to it.

## Stop, Cleanup, and Data Minimization

Remove synthetic records/accounts when the application provides a safe owner action, clear browser state, and redact cookies, tokens, personal data, and unrelated response content. Retain only evidence necessary to establish surface and provenance.

Research date: 2026-08-31

## Sources

- OWASP WSTG, Attack Surface Identification: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/04-Attack_Surface_Identification
- OWASP WSTG, Map Application Architecture: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/10-Map_Application_Architecture
- Nmap Reference Guide: https://nmap.org/book/man.html
