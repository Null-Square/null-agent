# HIPAA Security Rule Readiness Template

Use this template only when `.artifacts/report/compliance-context.json`
contains a selected `hipaa` framework.

## Required Boundary Language

State this exact sentence near the top of the report:

Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.

You may add this sentence after it, but do not replace the exact required
sentence:

This report is a HIPAA Security Rule readiness and supporting-evidence
assessment for administrative, physical, technical, organizational, and
documentation safeguards. It is not a HIPAA legal opinion, OCR determination,
certification, attestation, or substitute for a covered entity or business
associate risk analysis.

## Required Sections

1. Executive readiness summary
   - Selected scope and observation period.
   - Passed, failed, needs-action, not-checked, and excluded counts from compliance-context only.
   - Include two separate coverage counts: "This run assessed X/Y controls
     with direct agent check records" and "Overall framework readiness:
     denominator Y; N need action; M not checked." Do not merge these into a
     single score.
   - Count every backend status from compliance-context: passing, partial,
     failing, missing, stale, accepted_risk, not_applicable, and not_supported.
   - Separate NullSquare-proven technical evidence from administrative,
     physical, organizational, identity, logging, emergency-access,
     storage-encryption, and documentation gaps.

2. Scope and evidence basis
   - Source run ID and scope ID if provided.
   - Evidence sources used: findings, notes, scanner observations, inventory,
     artifacts, HTTP exchanges, and integration/user evidence when present.
   - State whether the tested surface is expected to create, receive,
     maintain, or transmit ePHI, if compliance-context provides that boundary.
   - If ePHI scope, covered-entity/business-associate role, or BAA boundary is
     absent, record that as a context limitation, not as a pass.

3. HIPAA Security Rule safeguard matrix
   - Group controls by Administrative, Physical, Technical, and Organizational.
   - One row or compact subsection per control present in compliance-context.
   - Use the backend status exactly: passing, partial, failing, stale,
     missing, accepted_risk, not_applicable, or not_supported.
   - Include support level when present: automated_testable,
     manual_evidence_required, integration_required, or out_of_selected_scope.
   - Include implementationSpec when present: required, addressable, or mixed.
   - Cite every supporting evidence item by sourceRef, findingId, note title,
     HTTP exchange, control-check ID, or artifact path.

4. Required vs Addressable safeguards
   - Addressable does not mean optional.
   - An Addressable safeguard may be supported by either implemented control
     evidence or documented risk-based alternative evidence.
   - A Required safeguard must not be described as satisfied by an alternative
     unless compliance-context records a passing or accepted-risk basis.
   - Mixed controls must clearly say which parts were evidenced and which
     parts remain unvalidated.

5. Failed and negative evidence
   - List controls with validated open negative evidence first.
   - Include severity, finding ID, and remediation direction.
   - Do not soften failing controls into "ready" language.

6. Non-agent evidence gaps
   - Group missing or partial controls by evidence support level.
   - For manual_evidence_required controls, request procedure or record
     evidence such as risk analysis, contingency, workforce, physical access,
     BAA, and documentation evidence.
   - For integration_required controls, name the system category needed,
     such as identity provider, storage/key management, endpoint/device
     management, audit logging, SIEM, or cloud configuration.

7. Remediation and readiness plan
   - Prioritize validated security findings before documentation-only gaps
     when risk is material.
   - Separate technical remediation from customer evidence collection,
     integration work, and ePHI/BAA context decisions.

8. Direct control-check evidence
   - For every control with controlChecks, include the latest check ID, verdict,
     method, target, run/session, created time, freshness expiry, evidence refs,
     reproduction state, and limitations.
   - Keep controls without a direct check explicitly not checked or in their
     customer-evidence state. Inferred notes and mappings are hints, not passes.

## Writing Rules

- Do not claim HIPAA compliance, HIPAA certification, OCR approval, attestation,
  or audit status.
- Do not introduce controls, statuses, scores, or evidence not present in
  compliance-context.
- Do not convert scanner-only or unreviewed evidence into passing language.
- Treat unauthenticated 401/403 responses as evidence of an observed
  authentication gate only. Do not describe them as strong authentication,
  MFA, unique user identification, automatic logoff, or emergency-access
  evidence unless compliance-context includes those exact facts.
- Keep the report focused on HIPAA Security Rule readiness. Do not include
  SOC 2, PCI DSS, ISO 27001, or NIST CSF readiness scores unless the operator
  explicitly requested a multi-framework report.
- If a control has no evidence, say that it is not validated for this scope.
- Use "readiness", "supporting evidence", "Security Rule", "safeguard",
  "implementation specification", "Required", "Addressable", "ePHI", and
  "gap" language.
