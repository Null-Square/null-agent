# ISO 27001 Readiness Template

Use this template only when `.artifacts/report/compliance-context.json`
contains a selected `iso27001` framework.

## Required Boundary Language

State this exact sentence near the top of the report:

Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.

You may add this sentence after it, but do not replace the exact required
sentence:

This report is an ISO/IEC 27001 readiness evidence assessment. It is
not an ISO/IEC 27001 certification, certification-body opinion, internal audit
conclusion, Statement of Applicability, or replacement for licensed standard
text.

## Required Sections

1. Executive readiness summary
   - Selected scope and observation period.
   - Passed, failed, needs-action, not-checked, and excluded counts from compliance-context only.
   - Include two separate coverage counts: "This run assessed X/Y controls
     with direct agent check records" and "Overall framework readiness:
     denominator Y; N need action; M not checked." Do not merge these into a
     single score.
   - Count every backend status from compliance-context: passing, partial,
     failing, missing, stale, not_applicable, and not_supported.
   - State that the matrix is a NullSquare readiness evidence view. It is not a
     certification audit or licensed-standard replacement.

2. Scope and evidence basis
   - Source run ID and scope ID if provided.
   - Evidence sources used: findings, notes, scanner observations, inventory,
     artifacts, HTTP exchanges, and integration/user evidence when present.
   - State coverage limitations from compliance-context.

3. ISO 27001 readiness evidence matrix
   - One row or compact subsection per control present in compliance-context.
   - Use the backend status exactly: passing, partial, failing, stale,
     missing, not_applicable, or not_supported.
   - Include support level when present: automated_testable,
     manual_evidence_required, integration_required, or out_of_selected_scope.
   - Cite every supporting evidence item by sourceRef, findingId, note title,
     HTTP exchange, or artifact path.

4. Failed and negative evidence
   - List controls with validated open negative evidence first.
   - Include severity, finding ID, and remediation direction.
   - Do not soften failing controls into "ready" language.

5. ISMS, Annex A, and integration gaps
   - Group missing or partial controls by evidence support level.
   - For manual_evidence_required controls, request ISMS scope, risk
     assessment, risk treatment, Statement of Applicability, management review,
     or physical/environmental records as applicable.
   - For integration_required controls, name the system category needed, such
     as SIEM/logging, identity provider, cloud, endpoint, or ticketing.

6. Remediation and readiness plan
   - Prioritize validated security findings before documentation-only gaps
     when risk is material.
   - Separate technical remediation from ISMS documentation, internal audit,
     and certification-body work.

7. Direct control-check evidence
   - For every control with controlChecks, include the latest check ID, verdict,
     method, target, run/session, created time, freshness expiry, evidence refs,
     reproduction state, and limitations.
   - Keep controls without a direct check explicitly not checked or in their
     request/evidence state. Inferred notes and mappings are hints, not passes.

## Writing Rules

- Do not copy ISO/IEC 27001 or ISO/IEC 27002 paid standard text into the
  report.
- Do not claim ISO/IEC 27001 certification, certification readiness, audit
  pass, or Statement of Applicability completeness.
- Do not introduce controls, statuses, scores, or evidence not present in
  compliance-context.
- Do not convert scanner-only or unreviewed evidence into passing language.
- Treat unauthenticated 401/403 responses as evidence of an observed
  authentication gate only. Do not describe them as strong authentication,
  MFA, identity governance, access reviews, or account lifecycle evidence
  unless compliance-context includes those exact facts.
- Keep the report focused on ISO 27001 readiness evidence. Do not include
  SOC 2, HIPAA, PCI DSS, or NIST CSF readiness scores
  unless the operator explicitly requested a multi-framework report.
- Use "readiness", "supporting evidence", "technical evidence", and "gap"
  language.
