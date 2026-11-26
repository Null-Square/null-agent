# CSV Formula Injection Methodology

Use this method to determine whether evaluator-controlled text is exported into a spreadsheet formula context. Proof is offline in an isolated spreadsheet using a harmless arithmetic canary; no network, file, or command-capable formulas are used.

## Preconditions and Fast Applicability

Require an evaluator-owned input field, an export workflow, the expected spreadsheet consumer, and an isolated viewer with external links/macros disabled. Default cap is six prefix variants and one export.

## Surface Discovery and Prioritization

Map input field to CSV cell, delimiter, quoting, encoding, line breaks, export transform, and spreadsheet import behavior. Prioritize fields at cell start in exports opened by staff workflows.

## Safe Test Ladder

1. Export a plain nonce and locate its exact cell.
2. Test a harmless arithmetic expression that evaluates to a known number.
3. Test leading whitespace/tab only when the exporter preserves it.
4. Test quoted and delimiter-adjacent placement.
5. Open offline with links, updates, and macros disabled.
6. Compare displayed formula versus evaluated result.
7. Delete the test export.

## Variation Matrix

| Axis | Variants |
|---|---|
| prefix | equals, plus, minus, at-sign as applicable |
| placement | first cell character, preserved leading whitespace |
| serialization | quoted, unquoted, delimiter boundary |
| viewer | one declared spreadsheet application |
| defense | apostrophe/text typing, sanitization |

## Proof Standard

Proof requires the exact evaluator cell to be interpreted as the harmless formula in the declared consumer, while a text-escaped control remains literal. Raw dangerous-looking CSV text, application reflection, or a viewer warning without evaluation is not proof.

## False Positives and Benign Lookalikes

- viewers differ in formula syntax;
- quoted CSV fields can still be formula cells;
- preview pages may not use spreadsheet semantics;
- apostrophe prefixes can be hidden but effective;
- locale separators can change parsing;
- import settings can force text.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without the real export, isolated declared viewer, or evaluator-owned field. Never use an external-link formula as a substitute. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for ordinary export and offline file inspection/viewing. Do not upload the test file to third-party viewers.

## Handoffs and Duplicate Prevention

Hand delimiter/header corruption to `header-injection` only when HTTP headers are involved and authorization of exports to `access-control`.

## Stop, Cleanup, and Data Minimization

Stop at one harmless evaluation, six variants, or any external-link prompt. Delete exports and retain the minimal redacted cell plus viewer evidence.

Never perform destructive actions or use formulas that access networks, files, commands, or other cells with real data.

Research date: 2026-07-23

## Sources

- OWASP WSTG, CSV Injection: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/21-Testing_for_CSV_Injection
- CWE-1236, Improper Neutralization of Formula Elements in a CSV File: https://cwe.mitre.org/data/definitions/1236.html
