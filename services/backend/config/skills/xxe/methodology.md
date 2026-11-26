# XML External Entity Methodology

Use this method to determine whether an XML-capable parser resolves attacker-controlled external entities or includes. All proof uses evaluator-owned markers and nonce-only callback endpoints.

## Preconditions and Fast Applicability

Require:

- an in-scope endpoint, upload processor, SOAP operation, SAML consumer, or document import that is confirmed to parse XML;
- a valid baseline document accepted by that parser;
- a unique evaluator marker available either at an owner-provided fixture URI or an approved callback endpoint; and
- agreement that no production local file or internal service will be requested.

The default limit is eight XML submissions per parser entrypoint, one entity reference per document, and a maximum response body of 256 KiB. Entity expansion amplification and parser resource-exhaustion tests are excluded.

## Surface Discovery and Prioritization

Inventory parser entrypoints and the parser actually reached:

- explicit XML request bodies and SOAP envelopes;
- SAML messages after protocol validation;
- SVG or office-document components processed server-side;
- XML content accepted through content-type negotiation;
- import jobs and webhook transformations; and
- white-box parser construction and security-feature configuration.

Prioritize a known XML parser with a valid baseline and observable result. Do not mutate signed protocol messages unless evaluator signing material and a test identity are supplied.

## Safe Test Ladder

### 1. Parser controls

Send the valid baseline, then a well-formed document with an inert internal entity. This distinguishes XML parsing from transport rejection and confirms whether entity substitution is visible.

### 2. External callback

Define one external entity whose URI is an evaluator callback path containing a fresh nonce. Reference it in one normally echoed or processed text node. Correlate callback time, source, method, and nonce to the request.

The callback returns a short inert string. It does not receive local data in its query, path, or body.

### 3. Evaluator fixture read

Only when the owner supplied a local test fixture URI, define the entity to that exact marker file. The marker contains one random line and no secret. Compare the returned value to its pre-recorded hash.

### 4. XInclude

If the parser rejects document type declarations but processes XInclude, include only the same evaluator-owned marker URI in a text node. Do not target internal HTTP services.

### 5. Upload container

For SVG or office-document processing, change a single XML component in a minimal valid file. Keep archive size below 100 KiB and preserve all other baseline components. Submit once and correlate the processing job.

Use one invalid host or nonexistent evaluator fixture as a negative control for any positive observation.

## Variation Matrix

| Axis | Bounded variants |
|---|---|
| XML carrier | request body, one approved upload format |
| entity kind | internal control, one external general entity |
| observation | inline evaluator marker, nonce-only callback |
| include mechanism | document type declaration, XInclude when applicable |
| processing | synchronous response, known background job |
| content type | documented XML type, one alternate type accepted by the route |

Parameter entities and chained remote definitions are not needed for B1 proof and are not tested.

## Proof Standard

A validated XXE finding requires:

1. a valid XML baseline;
2. a fresh evaluator marker or callback nonce;
3. parser-attributable observation of that exact value;
4. a negative control that does not produce the observation; and
5. evidence identifying the parser entrypoint and entity/include mechanism.

A parser error mentioning declarations, reflection of raw entity syntax, XML acceptance, or an uncorrelated callback is only a lead.

## False Positives and Benign Lookalikes

- A client or gateway can resolve or rewrite content before it reaches the application.
- A callback monitor can receive health checks unrelated to the nonce.
- Raw XML may be echoed without parser substitution.
- An upload preview can render client-side while server processing never parses XML.
- A document library can preserve an XML component without resolving its reference.
- Cached job results can repeat an earlier marker.

Use fresh nonces and a malformed-reference control to isolate parser behavior.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when no valid XML baseline exists, signature requirements cannot be met safely, callback attribution is unavailable, or the owner has not supplied a benign local fixture. Do not replace a missing fixture with a host or application file.

Document the parser entrypoint and exact missing prerequisite. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for exact XML submissions and response capture. Use an approved interaction monitor for nonce-only callbacks. Use archive tooling only to alter the single XML component of an evaluator-owned document. Use source inspection to verify parser features when available.

If an intermediary rewrites the XML, capture the post-intermediary request or move to an owner-provided integration test; do not increase payload complexity blindly.

## Handoffs and Duplicate Prevention

- Hand SOAP action and schema authorization defects to `soap-security`.
- Hand SAML/OIDC flow defects to `oauth-oidc`.
- Hand upload acceptance and serving behavior to `insecure-file-uploads`.
- Hand internal request behavior to `ssrf` only if a separately authorized, evaluator-owned network target is available.
- Hand resource amplification to `resource-consumption`; it is not exercised here.

This skill owns external entity resolution proof. Reuse the same parser exchange instead of reporting each carrier as a separate finding.

## Stop, Cleanup, and Data Minimization

Stop at first independently replayed marker observation, at eight submissions, or on parser instability. Delete evaluator upload artifacts and expire callback nonces. Retain the minimal XML diff and marker hash.

Never perform destructive actions, request production files, contact internal services, or attempt data transfer through entity values.

Research date: 2026-07-23

## Sources

- OWASP Web Security Testing Guide, XML Injection Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/07-Testing_for_XML_Injection
- PortSwigger Web Security Academy, XML External Entity Injection: https://portswigger.net/web-security/xxe
- CWE-611, Improper Restriction of XML External Entity Reference: https://cwe.mitre.org/data/definitions/611.html
