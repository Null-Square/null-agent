# PCI DSS v4.0.1 Readiness Template

Use this template only when `.artifacts/report/compliance-context.json`
contains a selected `pci_dss` framework.

## Required Boundary Language

State this exact sentence near the top of the report:

Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.

You may add this sentence after it, but do not replace the exact required
sentence:

This report is a PCI DSS v4.0.1 readiness assessment scoped to the stated CDE
and customer-declared SAQ/profile context. It is not a PCI DSS compliance
determination, ASV scan attestation, QSA Report on Compliance, completed
Self-Assessment Questionnaire, Attestation of Compliance, or acquiring-bank
submission.

## Required Sections

1. Executive readiness summary
   - Selected scope, observation period, CDE boundary, and declared SAQ/profile
     context when provided.
   - If CDE or SAQ context is missing, state that PCI readiness is unscoped or
     profile-unconfirmed. Do not infer the CDE or SAQ type from scanner output.
   - Passed, failed, needs-action, not-checked, and excluded counts from
     compliance-context only.
   - Include two separate coverage counts: "This run assessed X/Y controls
     with direct agent check records" and "Overall framework readiness:
     denominator Y; N need action; M not checked." Do not merge these into a
     single score.
   - Count every backend status from compliance-context: passing, partial,
     failing, missing, stale, not_applicable, and not_supported.

2. CDE, SAQ, and evidence basis
   - Source run ID and scope ID if provided.
   - Evidence sources used: findings, notes, scanner observations, inventory,
     artifacts, HTTP exchanges, and integration/user evidence when present.
   - Identify whether the tested surface is confirmed CDE, connected-to,
     security-impacting, payment-page, or unconfirmed scope if context allows.
   - State that SAQ applicability is customer-declared/profile context, not
     independently determined by NullSquare.
   - Never include real PAN, sensitive authentication data, or test card data.

3. PCI DSS safeguard matrix
   - One row or compact subsection per PCI control present in
     compliance-context.
   - Use the backend status exactly: passing, partial, failing, stale,
     missing, not_applicable, or not_supported.
   - Include support level when present: automated_testable,
     manual_evidence_required, integration_required, or out_of_selected_scope.
   - Include PCI metadata when present: requirement, PCI goal, approach,
     applicable SAQ types, CDE scope, and account-data type.
   - Cite every supporting evidence item by sourceRef, findingId, note title,
     HTTP exchange, or artifact path.

4. Failed and negative evidence
   - List controls with validated open negative evidence first.
   - Include severity, finding ID, and remediation direction.
   - Do not soften failing controls into "ready" language.

5. CDE, SAQ, TRA, and evidence gaps
   - Group missing or partial controls by support level and PCI requirement.
   - For manual_evidence_required controls, request policy, physical access,
     media handling, account-data handling, risk analysis, third-party, or
     governance records.
   - For integration_required controls, name the system category needed, such
     as SIEM/logging, identity provider, cardholder-data discovery, KMS/key
     management, malware protection, or payment-page monitoring.
   - For customized_eligible controls, request Targeted Risk Analysis and
     control-design/testing evidence before treating the control as supported.
   - For compensating-control evidence, require the constraint, alternative
     control, validation evidence, and owner/rationale.

6. Agent-tested technical readiness
   - Summarize bounded proof for network/security-control exposure, secure
     configuration, transmission cryptography, authorization, authentication,
     MFA, vulnerability scanning, penetration testing, segmentation, and
     payment-page script/tamper checks when present.
   - Explicitly state limitations, especially where private-runner placement,
     credentials, CDE diagrams, or payment-page URLs were not available.
   - ASV-style or external scan readiness evidence must not be described as an
     ASV scan unless the evidence is an actual third-party ASV artifact supplied
     by the customer.

7. Remediation and readiness plan
   - Prioritize validated security findings before documentation-only gaps
     when risk is material.
   - Separate technical remediation from PCI assessor, SAQ/ROC, AOC, ASV, and
     evidence collection work.

8. Direct control-check evidence
   - For every control with controlChecks, include the latest check ID, verdict,
     method, target, run/session, created time, freshness expiry, evidence refs,
     reproduction state, and limitations.
   - Keep controls without a direct check explicitly not checked or in their
     customer-evidence state. Inferred notes and mappings are hints, not passes.

## Writing Rules

- Do not claim PCI DSS compliance, PCI certification, ROC completion, SAQ
  completion, AOC issuance, ASV pass, ASV attestation, QSA approval, acquiring
  bank approval, or merchant-level validation.
- Do not introduce requirements, statuses, scores, or evidence not present in
  compliance-context.
- Do not convert scanner-only or unreviewed evidence into passing language.
- If a control has no evidence, say that it is not validated for this scope.
- Use "readiness", "supporting evidence", "CDE-scoped evidence", "SAQ profile
  context", and "gap" language.
- PCI DSS text is copyrighted. Use factual requirement numbers and owned
  paraphrased descriptions; do not paste requirement or testing-procedure text.
