# API Surface Enumeration Methodology

This skill builds a provenance-backed operation, parameter, identity, and state inventory for an authorized API. It must go beyond specification discovery and GET-only probing when normal application workflows are needed to reveal the real interface.

## Preconditions and Fast Applicability

Require a current authorized API origin or application namespace, explicit exclusions, an exact mission surface, and a request/time budget. Record available or provisionable evaluator identities and whether the application exposes public signup.

Do not infer authority from a mobile bundle, source map, redirect, CNAME, or specification server URL. Every origin is checked independently against the authorization namespace.

Never perform destructive actions. Never convert blocked or ambiguous work into a finding.

## Surface Discovery and Prioritization: Operation Confidence Model

Classify each operation as:

- **observed** — captured from a real browser/client/API exchange;
- **declared** — present in a hashed OpenAPI/AsyncAPI/Postman/service artifact;
- **referenced** — constructed in shipped client code or a response link;
- **corroborated** — declared/referenced and confirmed by a scoped request;
- **guessed** — wordlist or heuristic candidate only.

Only observed or corroborated operations count as confirmed coverage. Retain conflicts between spec, client, and runtime rather than overwriting them.

## Phase 1 — Establish Origins, Versions, and Identity States

1. Capture one normal request per known origin and record scheme, host, port, base path, content type, and authentication mechanism.
2. Inventory path, host, header, media-type, query, and GraphQL-operation versioning.
3. Map anonymous, synthetic-authenticated, and available role/tenant contexts.
4. Create the minimum synthetic identities through public signup when provisionable under bounded PoC.
5. Record session establishment, refresh, logout, CSRF, tenant selection, and client headers as interface context; hand vulnerability testing to the owning skill.

Do not mark authenticated API coverage blocked merely because credentials were not preattached when a safe public evaluator-account flow exists.

## Phase 2 — Capture the Real Client Interface

Use browser/mobile/client traffic before guessing paths:

1. Walk primary navigation and ordinary evaluator-owned workflows.
2. Capture XHR/fetch, GraphQL, WebSocket, upload/download, and background polling traffic.
3. Normalize operations by method plus templated path while retaining origin/version.
4. Record path/query/header/cookie/body parameters, content types, pagination, idempotency keys, and object identifiers.
5. Correlate UI actions and state transitions with the requests they produce.

For SPAs returning a universal shell, treat browser network traffic as the operation source. Do not count every client route as an API endpoint.

## Phase 3 — Specifications and Documentation

Search only high-probability, already authorized locations:

- linked `openapi.json`, `swagger.json`, `api-docs`, ReDoc, Postman, AsyncAPI, WSDL, and service descriptors;
- `/.well-known/` documents relevant to observed identity or API behavior;
- documentation links, response `Link` headers, and client configuration;
- GraphQL endpoint/operation references and gRPC reflection indicators.

Hash the artifact, parse it offline, and extract servers, operations, parameters, schemas, security requirements, tags, deprecation, callbacks, and webhooks. A foreign `servers` entry is not authorized by the spec.

Compare declared and observed operations to identify undocumented live routes, stale spec entries, and high-value operation families not yet exercised.

## Phase 4 — JavaScript and Static Client Mining

From directly referenced client assets:

1. Extract base URLs, route templates, operation names, GraphQL documents, feature flags, parameter names, and upload/content-type rules.
2. Resolve string concatenation and common client wrappers when practical.
3. Separate localhost/test/dead-code origins from runtime configuration.
4. Corroborate high-value same-scope references with one safe request or observed workflow.

Hand secret claims to information-disclosure validation; a token-shaped string is not automatically a live credential.

## Phase 5 — Bounded Active Discovery

Under confirmed API prefixes, use `katana`, `ffuf`, ordinary HTTP, and response links to resolve missing route families. Deduplicate soft-404s by status, normalized body hash, content type, title, and redirect behavior. Use a random nonexistent path as a control.

Probe useful version alternatives only when the current interface or client indicates versioning. Test exact case/trailing-slash/content-negotiation variants when they answer a concrete routing question; do not multiply every operation blindly.

Interpretation signals:

- `401/403` can confirm a routed protected operation;
- `405` plus `Allow` can identify method ownership but may originate at a gateway;
- schema-shaped validation errors can reveal parameters;
- distinct normalized bodies across identifiers/roles become validation leads;
- identical SPA/default pages are one wildcard result.

## Safe Test Ladder and Variation Matrix

Enumeration may execute ordinary bounded-PoC workflows when needed to reveal operations:

- `GET`/`HEAD` for known read semantics;
- `OPTIONS` when advertised or needed for a concrete method question;
- `POST` for login, public signup, search/filter, preview, or creation of an evaluator-owned synthetic object;
- `PUT`/`PATCH` only for reversible changes to an evaluator-owned object with a clean-session confirmation and cleanup plan;
- documented upload using an inert marker to map the interface.

Do not use `DELETE`, unknown economic/communication actions, bulk operations, real-user identifiers, or third-party callbacks during enumeration. A state-changing request must have known semantics, synthetic/evaluator-owned state, and a bounded expected result.

Vary one relevant axis at a time: identity state, role/tenant, method, content type, API version, path shape, or parameter location. Preserve the normal exchange so a route or schema difference is not mistaken for security proof.

## Protocol-Specific Branches

### GraphQL

Record endpoint, transport, operation names, variables, persisted-query behavior, batching indicators, and identity states. Hand schema/resolver/security testing to `graphql`; do not equate a GraphQL error with introspection support.

### gRPC

Record HTTP/2/content-type/reflection indicators and discovered service/method names. Hand reflection and method invocation to `grpc-security`.

### WebSocket and real-time

Record upgrade URL, subprotocol, authentication handshake, message shapes observed from normal workflows, and reconnect behavior. Hand authorization/message testing to `websockets`.

### SOAP/XML

Record WSDL/service/action and content type, then hand parsing and operation tests to `soap-security` or `xxe` as appropriate.

## Prioritization for Validation Handoffs

Create concrete leads for:

- authentication/session/token operations;
- user/tenant/object CRUD and nested resources;
- administration, role, invite, approval, and access-grant operations;
- upload/import/export/download/report generation;
- search/filter/sort/template/render/fetch/callback parameters;
- price, quantity, discount, credit, order, inventory, and one-time actions;
- batch/bulk endpoints and alternate API versions;
- GraphQL mutations and sensitive resolver fields.

Each lead names the operation, identity prerequisite, controllable field, observed signal, smallest safe next experiment, and owning vulnerability skill.

## Proof Standard

An operation requires a captured exchange, a hashed declaration, a shipped-client reference plus corroboration, or a link from a confirmed response. Record method, path template, parameters by location, content types, auth/role state, provenance, and last observation.

This skill does not promote vulnerabilities. Wordlist hits, generic errors, version banners, and different lengths are leads until class-specific proof exists.

## False Positives and Benign Lookalikes

Suppress wildcard routes, universal SPA shells, gateway-generated `401`/`403`/`405` responses, stale specification entries, dead client constants, uniform proxy errors, and method responses that do not reach an application handler. Use random nonexistent paths, normalized bodies, provenance, and a second indicator before confirming an operation.

## Missing Prerequisites and Blocked Behavior

Classify prerequisites as available, provisionable, blocked, or prohibited. Provision public evaluator identities or objects when permitted. Record exact missing roles, client builds, specs, protocol tooling, or private-runner access; never convert absence into a negative security result.

## Tool Selection and Fallback

Prefer captured browser/client traffic, then specifications and shipped-client references, then bounded active discovery. Use structured outputs from `katana`, `ffuf`, and HTTP tooling. If one source is unavailable, move to the next provenance class and record the gap; do not inflate guessed routes into confirmed coverage.

## Handoffs and Duplicate Prevention

- `idor`/`access-control` own object, tenant, and role boundaries.
- `broken-auth`, `oauth-oidc`, `jwt-attacks`, and `session-management` own identity controls.
- `mass-assignment` owns undocumented writable properties.
- injection, SSRF, upload, business-logic, GraphQL, gRPC, SOAP, and WebSocket skills own their primitives.

Keep one canonical operation ledger. Downstream missions reference operation identifiers rather than recreating endpoint notes.

## Stop, Cleanup, and Data Minimization

Stop after two applicable discovery methods add no new high-value operation/parameter/identity family, only guessed/wildcard results remain, or the mission budget ends. Clean up evaluator-owned state, clear sessions, and redact tokens, cookies, personal data, and unrelated bodies.

Research date: 2026-08-31

## Sources

- OWASP WSTG, Attack Surface Identification: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/04-Attack_Surface_Identification
- OpenAPI Specification: https://spec.openapis.org/oas/latest.html
- GraphQL Specification: https://spec.graphql.org/
- OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
