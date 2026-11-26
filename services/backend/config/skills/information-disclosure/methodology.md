# Information Disclosure Methodology

Use this method to validate whether an in-scope application exposes data, diagnostics, source artifacts, or configuration beyond its intended audience. Do not use discovered credentials or expand into other systems.

## Preconditions and Fast Applicability

Require an exact origin or repository artifact, intended audience for the data class, and a bounded discovery list derived from observed technology or published application paths. For identity-separated proof, use only supplied evaluator accounts and evaluator-owned records.

Default cap: thirty path requests per origin, ten malformed-input controls, response bodies retained only when needed and redacted at capture.

## Surface Discovery and Prioritization

Prioritize evidence-backed surfaces:

- response bodies, headers, comments, and client bootstrap data;
- published source maps and build manifests;
- error responses from normal and minimally malformed evaluator input;
- directory listings and backup/config paths suggested by observed names;
- API response fields not used by the client;
- logs/diagnostics exposed through documented routes; and
- repository artifacts in white-box mode.

Classify data as public, internal metadata, personal evaluator data, secret material, source, or operational diagnostics. A filename guess without a confirming response is not a surface.

## Concrete Discovery Reference

Work this list within the thirty-path cap, newest/highest-signal first, each with a random-nonexistent control:

- **Passive maps:** `robots.txt`, `sitemap.xml`, `security.txt`, and certificate-transparency SAN history for extra hostnames (hand new hosts to `broad-surface-scan`).
- **VCS exposure:** `/.git/HEAD`, `/.git/config`, `/.svn/entries` — a readable `.git/config` or `HEAD` is a high-signal disclosure; do not clone/pull the tree, capture the proof and stop.
- **Config/secrets at root:** `/.env`, `/config.json`, `/appsettings.json`, `/wp-config.php.bak`, and backup/editor forms of known files (`.bak`, `.old`, `.orig`, `~`, `.swp`).
- **Editor/OS artifacts:** `/.DS_Store` (null-delimited UTF-16LE filenames — a directory map), `/.idea/`, `/.vscode/`.
- **Framework debug/diagnostics:** Spring Boot `/actuator`, `/actuator/env`, `/actuator/heapdump`; Django/Flask debug tracebacks; Laravel `/telescope`, `/_ignition/health-check`; `/debug`, `/status`, `/metrics`, `/phpinfo.php`.
- **Client bootstrap:** inline JSON/state in HTML and published `*.map` source maps (inventory to `js-surface-analysis`).
- **Verbose errors:** one minimally malformed value per input to surface a stack/version banner (a lead, not proof).

Capture only the redacted proof for any secret-like hit; never test the value or use it to reach another system.

## Safe Test Ladder

1. Capture a normal response and its intended public data.
2. Inspect linked and published artifacts before path guessing.
3. Request one technology-specific candidate and one random nonexistent path; compare status, body hash, and content type.
4. Trigger one syntax-neutral validation error, then one minimally malformed value.
5. Compare anonymous and evaluator identity responses for the same evaluator-owned record.
6. For source maps, verify the declared map and inspect offline.
7. For a candidate secret, capture only type, location, redacted prefix/suffix, and hash.
8. Stop without testing validity or using the value.

Do not enumerate directories recursively, download bulk datasets, or induce server crashes.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| source | response, header, error, published artifact, API field, repository |
| identity | anonymous, supplied evaluator account/role |
| path | observed/derived candidate, random nonexistent control |
| input | normal, syntax-neutral invalid, one minimally malformed |
| data class | public, internal, personal, secret-like, source, diagnostic |
| build | active deployed build identifier |

One candidate/data class is evaluated at a time.

## Proof Standard

Proof requires the exact data, its source response/artifact, the audience that should not receive it, and a matched control. Sensitive values are hashed/redacted immediately. For cross-identity disclosure, evidence uses evaluator-owned data and confirms the server-recognized identity.

A server banner, generic stack identifier, technology version, route existence, secret scanner match, or inaccessible source-map reference is not a finding by itself.

## False Positives and Benign Lookalikes

- public keys and client identifiers can intentionally be public;
- generic framework error pages can contain no sensitive detail;
- source maps can belong to a stale build;
- a CDN can serve an old artifact after origin removal;
- API fields may be intentionally shared for the tested role;
- synthetic scanner tokens can resemble credentials;
- random paths can receive the SPA shell.

Confirm active-build provenance and data classification.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when data ownership/audience is unknown, evaluator identities are unavailable, retention policy forbids capture, or the only validation would require using a candidate credential. Record the redacted candidate and required owner decision.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser and `http_payload` for exact responses, `file_read` for offline artifacts, and owned secret scanners for candidate classification. Configure tools to redact values and store machine-readable paths/hashes.

If content is large, capture the minimum excerpt around the disclosure and its hash rather than the whole response.

## Handoffs and Duplicate Prevention

- Hand cross-object authorization to `idor`.
- Hand JavaScript/source-map inventory to `js-surface-analysis`.
- Hand exposed repository secrets to `source-aware-whitebox` for remediation trace, not validity testing.
- Hand cloud storage policy to the applicable cloud skill.
- Hand server error root causes to the class-specific input skill.

This skill owns unintended data exposure. One root artifact exposed at multiple URLs is one finding.

## Stop, Cleanup, and Data Minimization

Stop at one independently confirmed disclosure, thirty paths, or any unexpectedly large response. Delete unneeded raw bodies, redact values, and retain hashes plus minimal excerpts.

Never perform destructive actions, use discovered secrets, or collect unrelated personal data.

Research date: 2026-07-23

## Sources

- OWASP WSTG, Review Web Page Content for Information Leakage: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Webpage_Content_for_Information_Leakage
- OWASP WSTG, Testing for Error Code: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/08-Testing_for_Error_Handling/01-Testing_for_Improper_Error_Handling
- OWASP API3:2023 Broken Object Property Level Authorization: https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/
