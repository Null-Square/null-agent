---
slug: compliance-evidence-review
name: Compliance Evidence Review
description: Agent review of mapped user-uploaded or integration evidence for selected compliance controls.
phase: control_assessment
compatible_phases:
  - control_assessment
category: compliance
required_tools:
  - query_compliance_readiness
  - query_compliance_evidence
  - map_compliance_evidence
  - record_control_check
  - record_control_request
  - review_control_request
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use when a dedicated compliance control_assessment mission evaluates a selected control from mapped uploaded evidence or integration evidence rather than direct technical testing, or when missing evidence/access/context must be requested for a selected manual or integration control.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - One terminal action per selected evidence-review control
  - A record_control_check when evidence is available to review
  - Verdict basis set to agent_reviewed_user_evidence or agent_reviewed_integration
  - Suggested mappings for clearly relevant unmapped evidence before review
  - A record_control_request when missing document scope, dates, owner, system boundary, export detail, access, or remediation blocks an honest verdict
  - A review_control_request call after reviewing a fulfilled agent request
evidence_floor: Conclusive pass/fail checks must cite at least one durable compliance-evidence ref mapped to the selected control. Missing evidence should create a concrete record_control_request, not a guessed verdict.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - compliance-evidence-review
  - compliance
  - evidence review
  - user evidence
  - integration evidence
  - record_control_check
  - evidence
  - review
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:compliance-evidence-review
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - compliance-planning
handoff_skills:
  - compliance-reporting
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
fixture_manifest: fixtures/manifest.yaml
---
# compliance-evidence-review

Use this skill only in a `control_assessment` phase when the selected control is being evaluated from user-uploaded evidence or integration evidence rather than direct adversarial testing.

## Objective

Review mapped evidence for selected compliance controls and record the agent's verdict with `record_control_check`. When no usable evidence exists, create a specific `record_control_request` instead of leaving the control silent.

## Rules

- Do not run a pentest.
- Do not create or mutate findings.
- Do not approve evidence as a human reviewer.
- Evaluate only selected controls. If `query_compliance_evidence` returns an unmapped library item that clearly matches a selected control, call `map_compliance_evidence` with `mappingSource="system_suggested"` and a rationale before using it.
- Cite durable evidence refs as `compliance-evidence:{evidenceItemId}`.
- When evidence is missing required scope, date, owner, boundary detail, system export, access, context, or remediation proof, record a concrete request with `record_control_request`.
- Check `.compliance/open-requests.json` before creating a request. If an active
  request already covers the same missing material, reference that request in
  the control-check reason/limitations instead of creating a duplicate. If no
  active request exists and the blocker is customer-actionable, the evidence
  review is incomplete until you call `record_control_request`. Only omit a
  request when the blocker is not customer-actionable, such as target downtime
  or a tool limitation, and state that explicitly in the check.
- When a selected control has a fulfilled action request, review that fulfillment and then call `review_control_request` with:
  - `reviewed` when the fulfilled evidence was accepted as usable for the recorded check.
  - `insufficient` when the fulfillment is relevant but still lacks required context.
  - `contradicted` when the fulfillment shows the expected control state is not true.
- Use `basis="agent_reviewed_user_evidence"` for user uploads or attestations.
- Use `basis="agent_reviewed_integration"` for integration-synced evidence.
- For controls without a technical proof obligation, use the exact
  `proofObligationId="evidence-review:{frameworkKey}:{controlId-lowercase}"`
  supplied in TARGET CONTEXT.

## Verdict Guidance

- `pass`: evidence is mapped to the control, durable, current enough for the stated period, and directly supports the requirement.
- `fail`: evidence shows the control is not operating or contradicts the requirement.
- `needs_context`: evidence is relevant but missing scope, dates, owner, system boundary, or other context needed to conclude.
- `not_attempted`: use only when a check record is still useful for a bounded attempted review. If the user must provide missing evidence, access, context, or remediation before review, create or reference a `record_control_request`; a not-attempted check alone is not a complete terminal action for a customer-actionable blocker.

## HIPAA Evidence Mapping Notes

When the selected framework is `hipaa`, use the supplied control IDs and
implementationSpec metadata from TARGET CONTEXT:

- Risk analysis, risk treatment, sanctions, and system activity review evidence
  map to `164.308(a)(1)`.
- Security owner or HIPAA security official evidence maps to `164.308(a)(2)`.
- Workforce authorization, clearance, training, and offboarding records map to
  `164.308(a)(3)` and `164.308(a)(5)` as applicable.
- Incident response plans, incident tickets, and tabletop records map to
  `164.308(a)(6)`.
- Backup, disaster recovery, emergency-mode operation, and criticality-analysis
  evidence maps to `164.308(a)(7)`.
- Facility, workstation, endpoint, and device/media custody evidence maps to
  `164.310(a)(1)`, `164.310(b)`, `164.310(c)`, or `164.310(d)(1)`.
- Identity-provider exports, emergency access, automatic logoff, encryption,
  audit log, integrity, authentication, and TLS evidence map to the relevant
  `164.312` technical safeguards.
- BAA/vendor ePHI handling evidence maps to `164.314(a)`.
- Security Rule policy, procedure, retention, availability, and update evidence
  maps to `164.316`.

Addressable HIPAA implementation specifications are not optional. A pass needs
implemented-control evidence or documented risk-based alternative evidence. If
neither exists, create a specific request instead of treating the control as
not applicable.

## PCI DSS Evidence Mapping Notes

When the selected framework is `pci_dss`, review only PCI DSS v4.0.1 readiness
evidence for the stated CDE and customer-declared SAQ/profile context. Do not
infer the CDE or SAQ type from scanner output, and do not store or reproduce
real PAN, sensitive authentication data, or test card data.

- CDE boundary, network diagrams, firewall/cloud network exports, and
  segmentation evidence map to `1.2`, `1.3`, `1.4`, and `11.4.5`.
- Secure configuration baselines and default-hardening evidence map to `2.2`
  and `2.3`.
- Cardholder-data inventory, SAD non-retention, PAN unreadability, and
  key-management evidence map to `3.2`, `3.3`, `3.5`, `3.6`, and `3.7`.
- TLS/certificate or encrypted-transport evidence for payment paths maps to
  `4.2`.
- EDR, anti-malware, anti-phishing, and malware-monitoring evidence maps to
  `5.2`, `5.3`, and `5.4.1`.
- Secure SDLC, vulnerability-management, code review, change-management, and
  payment-page script inventory evidence maps to `6.2`, `6.3`, `6.4.3`, and
  `6.5`.
- Identity provider, RBAC, access review, MFA, and authentication-policy
  evidence maps to `7.2`, `7.3`, `8.2`, `8.3`, `8.4.2`, and `8.5`.
- Physical access and media handling evidence maps to `9.1`, `9.2`, and `9.5`.
- SIEM/logging, log schema, automated review, alerting, and time sync evidence
  maps to `10.2`, `10.3`, `10.4.1.1`, and `10.6`.
- Internal/external scan, pentest, segmentation-test, and payment-page tamper
  evidence maps to `11.3.1`, `11.3.2`, `11.4`, `11.4.5`, and `11.6.1`.
- Security policy, targeted risk analysis, customized approach evidence,
  third-party/TPSP management, and incident response evidence maps to `12.1`,
  `12.3.1`, `12.3.2`, `12.8`, and `12.10`.

If TARGET CONTEXT marks a control `customized_eligible`, a pass from user or
integration evidence needs Targeted Risk Analysis plus designed-control/testing
evidence. If a customer supplies compensating-control evidence, require the
constraint, alternative control, validation evidence, and owner/rationale. If
those are missing, create a specific request.

## GDPR Evidence Mapping Notes

When the selected framework is `gdpr`, review readiness evidence only. Do not
give legal advice and do not conclude that a lawful basis, DPIA, DPA, SCC,
transfer safeguard, or processor agreement is legally correct, sufficient,
enforceable, or approved.

- Applicability, controller/processor role, DPO, governance, RACI, and privacy
  risk evidence maps to the selected scope/applicability, accountability, or
  DPO role controls from TARGET CONTEXT.
- RoPA, processing register, data-flow inventory, data-category inventory, and
  special-category assessments map to selected processing-record and
  data-category controls.
- Lawful-basis matrix, purpose inventory, legitimate-interest assessment,
  consent records, withdrawal process, and child-consent rationale map to
  selected lawful-basis and consent controls.
- Privacy notice, transparency page, DSAR procedure, request logs,
  identity-verification process, response-SLA evidence, and automated-decision
  or profiling assessment map to selected transparency, rights, and
  automated-decision controls.
- Retention schedules, deletion/anonymisation procedure, erasure workflow,
  privacy-by-design checklists, design reviews, and DPIA/screening evidence map
  to selected retention, privacy-by-design, and DPIA/risk controls.
- Processor/vendor inventory, DPA, subprocessor list, SCCs, transfer inventory,
  TIA, and supplementary safeguard evidence map to selected processor and
  transfer-safeguard controls.
- Personal data breach procedure, breach register, notification decision tree,
  affected-individual communication template, and tabletop evidence map to
  selected breach-response controls.
- Security policy, vulnerability scan, access-control, identity, encryption,
  backup, restore, monitoring, and resilience evidence may support only the
  selected Article 25/32-style GDPR security controls.

For missing privacy evidence, create specific requests such as RoPA, privacy
notice, lawful-basis matrix, DPA/SCC, DPIA/screening, DSAR process/log, breach
register, retention schedule, DPO rationale, transfer inventory, processor
inventory, or controller/processor role evidence. Redact personal data and cite
evidence handles or metadata rather than copying personal data into the check.

## Required Fields

Every conclusive check must include:

- `basis`
- `verdict`
- `reasonCode`
- `reason`
- `proofObligationId`
- `targetRef`
- `method`
- `evidenceRefs`
- `proof.claim`
- `proof.evidenceIds`
- `proof.replayAttempted=false`
- `proof.notReplayedReason="document_evidence_review"` or `"integration_evidence_review"`
- `limitations`
- `freshUntil`

## Example

```json
{
  "frameworkKey": "selected-framework-key",
  "controlId": "SELECTED-CONTROL-ID",
  "basis": "agent_reviewed_user_evidence",
  "verdict": "pass",
  "reasonCode": "control_operating",
  "proofObligationId": "evidence-review:selected-framework-key:selected-control-id",
  "evidenceRefs": ["compliance-evidence:00000000-0000-4000-8000-000000000000"],
  "targetRef": "uploaded evidence mapped to SELECTED-CONTROL-ID",
  "method": "agent review of uploaded compliance evidence",
  "limitations": ["Document review does not independently test operating effectiveness outside the evidence period."],
  "proof": {
    "claim": "The uploaded evidence supports the stated control requirement for the mapped scope and period.",
    "evidenceIds": ["compliance-evidence:00000000-0000-4000-8000-000000000000"],
    "replayAttempted": false,
    "notReplayedReason": "document_evidence_review"
  }
}
```
