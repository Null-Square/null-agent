# Server-Side Template Injection Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Apply when user-controlled text is rendered by a server template in email previews, document generation, CMS themes, notification bodies, error pages, or configurable labels. Capture the literal baseline rendering and any framework/template fingerprint separately.

A reflected delimiter, template error, or installed engine version is not sufficient. Stop as not applicable when the value is rendered only by the browser, is encoded as plain text, or never crosses a server-side template boundary.

## Surface Discovery and Prioritization

1. Map where the same marker appears: raw HTTP response, generated file, email capture, server log, or delayed job output.
2. Use source evidence to identify the engine and sandbox mode: Jinja2, Twig, Freemarker, Velocity, Thymeleaf, Razor, Handlebars, or another observed engine.
3. Determine the insertion context: expression, statement, string literal, attribute, template name, or include path.
4. Prioritize templates editable by lower-privileged users that are rendered for another authorized persona or by a background worker.

## Safe Test Ladder

1. Render a unique literal marker and an escaped-delimiter control.
2. Evaluate a harmless arithmetic expression whose result cannot arise from string concatenation, such as two nontrivial integers.
3. Pair it with a syntactically similar expression expected to remain literal or evaluate differently.
4. Confirm in a second render or clean job and capture the rendered artifact plus template input.
5. Stop at expression evaluation. Do not enumerate objects, read files, access environment values, start processes, or construct engine-specific RCE chains.

At most six candidates may be sent to one template, one at a time. Cancel queued test renders after proof.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Delimiter family: select only from the engine suggested by errors or source; do not spray every template syntax.
- Context: plain expression, quoted expression, attribute, block, or template name.
- Whitespace and trimming: canonical first, then one engine-supported trim marker.
- Encoding: raw, HTML-encoded, URL-encoded, or JSON-escaped according to the delivery channel.
- Render lifecycle: immediate response, preview, saved template, background email, or generated document.
- Identity: author view versus an authorized reviewer render when stored behavior matters.

## Proof Standard

Proof is a deterministic server-rendered value derived from a harmless expression, reproduced with an unchanged control and tied to the submitted template input. A stack trace naming an engine remains a lead. Do not require or attempt command execution to validate SSTI.

## False Positives and Benign Lookalikes

1. Client-side JavaScript evaluates or replaces the marker after the HTTP response.
2. The application has an intentional documented merge-tag language with a strict allowlist.
3. Curly braces are normalized, stripped, or reflected without evaluation.
4. A math-looking result was already present in cached content or produced by string interpolation.
5. A template compile error reveals the engine but shows no attacker-controlled expression evaluation.

## Missing Prerequisites and Blocked Behavior

Block when the rendered artifact cannot be retrieved, the job queue cannot be correlated, a required reviewer persona is unavailable, or the only next step would access sensitive objects. Record the engine hypothesis and exact safe expression/control needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use HTTP replay for previews, browser automation only to retrieve the rendered artifact, and file/repository reads to confirm engine/context. Use local `python_session` comparison for artifact normalization. Keep scanner output as a lead and manually retain the two render inputs and outputs.

## Handoffs and Duplicate Prevention

Send source/context details to `source-aware-whitebox`, stored cross-persona rendering to the owning workflow skill, and confirmed expression evaluation to `validation`. `rce` may describe potential severity after proof but must not repeat unsafe escalation. XSS owns browser-side execution.

## Stop, Cleanup, and Data Minimization

Delete test templates and generated artifacts, cancel preview jobs, and retain only the sanitized input/output pair and control. Stop after arithmetic proof or two engine-specific delimiter families fail.

## Sources

- [PortSwigger Web Security Academy - Server-side template injection](https://portswigger.net/web-security/server-side-template-injection)
- [CWE-1336: Improper Neutralization of Special Elements Used in a Template Engine](https://cwe.mitre.org/data/definitions/1336.html)
