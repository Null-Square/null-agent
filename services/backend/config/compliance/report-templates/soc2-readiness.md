# SOC 2 Security Readiness Template

Use this template only when `.artifacts/report/compliance-context.json`
contains a selected `soc2` framework.

## Required Boundary Language

State this exact sentence near the top of the report:

Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.

You may add this sentence after it, but do not replace the exact required
sentence:

This report is a SOC 2 Security readiness and supporting-evidence assessment.
Only an independent qualified auditor can issue a SOC 2 report.

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
   - If you include a status-count table, copy the counts exactly from
     compliance-context or `.artifacts/report/brief.md`; do not hand-calculate
     and do not omit not_supported or not_applicable rows.
   - One sentence separating tested technical evidence from manual and
     integration evidence gaps.

2. Scope and evidence basis
   - Source run ID and scope ID if provided.
   - Evidence sources used: findings, notes, scanner observations, inventory,
     artifacts, HTTP exchanges, and uploaded/integration evidence when present.
   - Explicit coverage limitations from compliance-context.

3. SOC 2 Security criteria matrix
   - One row or compact subsection per CC1.1 through CC9.2 criterion present
     in compliance-context.
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

5. Manual and integration evidence gaps
   - Group missing or partial controls by evidence support level.
   - For manual_evidence_required controls, request specific documents or
     records.
   - For integration_required controls, name the system category needed
     without pretending it has already been connected.

6. Remediation and readiness plan
   - Prioritize validated security findings before documentation-only gaps
     when risk is material.
   - Separate quick evidence collection from technical remediation and
     integration work.

7. Direct control-check evidence
   - For every control with controlChecks, include the latest check ID, verdict,
     method, target, run/session, created time, freshness expiry, evidence refs,
     reproduction state, and limitations.
   - For pass verdicts, show limitations beside the pass statement so the
     reader sees the tested boundary immediately.
   - Keep controls without a direct check explicitly not checked or in their
     customer-evidence state. Inferred notes and mappings are hints, not passes.

## Writing Rules

- Do not introduce criteria, statuses, scores, or evidence not present in
  compliance-context.
- Do not convert scanner-only or unreviewed evidence into passing language.
- If a criterion has no evidence, say that it is not validated for this scope.
- If a criterion is outside selected scope, explain why it is out of scope;
  otherwise treat missing SOC 2 Security criteria as missing evidence.
- Use "readiness", "supporting evidence", and "gap" language. Avoid
  "certified", "attested", "audit passed", or "SOC 2 compliant".
