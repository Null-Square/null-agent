---
slug: compliance-governance-review
name: Compliance Governance Review
description: Agent review of governance, policy, risk, oversight, and management-system evidence for selected controls.
phase: control_assessment
compatible_phases:
  - control_assessment
category: compliance
required_tools:
  - query_compliance_readiness
  - query_compliance_evidence
  - map_compliance_evidence
  - annotate_compliance_evidence
  - record_control_check
  - record_control_request
  - review_control_request
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use when selected controls require evaluating governance design or operation, including scope, ownership, approval, risk decisions, review cadence, management oversight, supplier governance, continuity, or corrective action.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Selected framework control and evidence-review obligation
  - Mapped uploaded or integration evidence
  - Current action requests and prior control checks
expected_outputs:
  - One terminal action per selected governance control
  - Evidence-bounded record_control_check verdicts
  - Specific record_control_request items for missing governance evidence or context
  - Reviewed request outcomes when fulfilled evidence is available
evidence_floor: A conclusive verdict must cite durable mapped evidence and evaluate its scope, owner, approval, effective period, operating cadence, and follow-through where those attributes matter to the selected obligation.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - compliance-governance-review
  - governance review
  - policy ownership
  - risk management
  - management review
  - corrective action
  - compliance
  - governance
  - review
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:compliance-governance-review
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
# Compliance Governance Review

Use this method only for selected governance-oriented controls. The selected
framework obligation in TARGET CONTEXT defines what must be true; this skill
defines how to review the evidence. Do not import criteria or control IDs from
another framework.

## Review Method

1. Identify the exact selected control, obligation, scope, and observation period.
2. Query mapped evidence and open requests before asking for anything new.
3. Review the evidence for the dimensions relevant to the obligation:
   - defined scope and covered systems or business units;
   - accountable owner and approving authority;
   - approval, effective, review, and expiry dates;
   - operating cadence and at least one execution sample when operation matters;
   - decisions, exceptions, follow-up actions, and closure evidence;
   - consistency between policy, records, integrations, and observed practice.
4. Map clearly relevant unmapped evidence with a rationale and citation anchor.
5. Record one evidence-bounded verdict or one concrete action request.

## Verdict Rules

- `pass`: durable, current evidence directly supports the selected obligation
  for the stated scope and period. State limitations and sample boundaries.
- `fail`: evidence directly contradicts the obligation or shows the required
  governance activity did not operate.
- `needs_context`: relevant evidence exists but lacks scope, owner, approval,
  dates, cadence, samples, or follow-through needed for a conclusion.
- `not_attempted`: use only when a bounded review attempt itself must be
  recorded. Prefer an action request when customer-provided evidence can unblock
  the review.

Use `basis="agent_reviewed_user_evidence"` or
`basis="agent_reviewed_integration"`. Cite durable
`compliance-evidence:{evidenceItemId}` references and use the exact
`evidence-review:{frameworkKey}:{controlId-lowercase}` obligation supplied by
the run. Never treat a mapping, filename, policy title, or unsupported
attestation as proof by itself.

Before creating a request, inspect `.compliance/open-requests.json`. Refresh or
reference an existing active request that asks for the same material instead of
creating a duplicate. After reviewing fulfilled evidence, record the check and
call `review_control_request` with `reviewed`, `insufficient`, or `contradicted`.

## HIPAA Governance Notes

For `hipaa`, review only Security Rule readiness evidence, not Privacy Rule or
Breach Notification obligations. The common governance mappings are:

- `164.308(a)(1)`: risk analysis, risk management, sanction policy, system
  activity review.
- `164.308(a)(2)`: named security official or security responsibility.
- `164.308(a)(3)`: workforce authorization, clearance, and termination.
- `164.308(a)(4)`: information access authorization and access changes.
- `164.308(a)(5)`: security awareness, malware protection, login monitoring,
  password-management evidence.
- `164.308(a)(6)`: security incident response and reporting.
- `164.308(a)(7)`: backup, disaster recovery, emergency-mode operation,
  test/revision, and criticality evidence.
- `164.308(a)(8)`: periodic technical and non-technical evaluation.
- `164.310*`: facility, workstation, and device/media evidence.
- `164.314(a)`: Business Associate Agreement or third-party ePHI handling evidence.
- `164.316`: Security Rule policy/procedure and documentation retention evidence.

If TARGET CONTEXT marks a safeguard `addressable`, require either operating
control evidence or a documented risk-based alternative. If it marks a safeguard
`mixed`, state which required/addressable parts the evidence supports and what
remains unvalidated.

## PCI DSS Governance Notes

For `pci_dss`, review readiness evidence only for the declared PCI DSS v4.0.1
CDE and SAQ/profile context. Never claim PCI compliance, ASV status, QSA
approval, ROC completion, SAQ completion, or AOC issuance.

- `12.1`: approved PCI-scoped security policy and responsibility evidence.
- `12.3.1`: Targeted Risk Analysis for flexible-frequency control decisions.
- `12.3.2`: Targeted Risk Analysis, control design, and testing evidence for
  customized approach controls.
- `12.8`: third-party service provider inventory, responsibility matrix, and
  provider assurance evidence.
- `12.10`: incident response plan, payment-data incident playbook, escalation,
  and tabletop or exercise records.
- `9.1`, `9.2`, and `9.5`: physical access, visitor, facility, and media
  handling governance evidence.

For PCI controls marked `customized_eligible`, do not treat a policy statement
alone as a pass. Require the TRA plus designed-control/testing evidence, or
create a request. For compensating controls, require the documented constraint,
alternative control, validation evidence, and owner/rationale.

## GDPR Privacy Governance Notes

For `gdpr`, review GDPR readiness evidence only. This is not legal advice, a
GDPR certification, a DPO opinion, a supervisory-authority opinion, or an audit
attestation. Do not decide that a lawful basis, DPIA, DPA, SCC, transfer
safeguard, or processor agreement is legally correct, sufficient, enforceable,
or approved.

Use the selected GDPR control IDs from TARGET CONTEXT. Review whether evidence
is documented, current enough for the stated period, internally consistent,
linked to the selected scope, and clear about owner, role, processing context,
effective date, review date, and limitations:

- Scope/applicability controls: GDPR territorial/applicability rationale,
  EU/EEA establishment or targeting evidence, monitoring/profiling context,
  and controller/processor relationship evidence.
- Accountability controls: privacy owner, governance policy, RACI, privacy
  risk register, oversight cadence, and demonstrability evidence.
- DPO or privacy-contact controls: DPO appointment, non-applicability rationale,
  privacy contact role, independence, escalation, and responsibility evidence.
- Processing-record controls: RoPA or processing register with categories,
  recipients, transfers, retention, and security-measure entries where
  available.
- Data-category controls: personal-data category inventory, special-category
  assessment, criminal-conviction data assessment, and classification records.
- Lawful-basis controls: lawful-basis matrix, purpose inventory,
  legitimate-interest assessment, consent/contract basis evidence, and
  special-category condition evidence where applicable. Record only whether the
  basis is documented and internally consistent.
- Consent controls: consent text, consent logs, withdrawal process, and child
  consent or age-gating rationale where applicable.
- Rights controls: DSAR procedure, intake path, request log,
  identity-verification process, one-month response tracking, and
  refusal/extension rationale records.
- Automated-decision controls: profiling inventory, automated-decision
  non-applicability rationale, user notice, human-review process, and model or
  rules explanation evidence.
- Retention controls: retention schedule, deletion/anonymisation procedure,
  erasure workflow, data minimisation rationale, and data lifecycle evidence.
- Privacy-by-design controls: privacy-by-design checklist, design review,
  product privacy requirement, default sharing settings, and access-by-default
  rationale.
- DPIA/risk controls: DPIA, screening questionnaire, high-risk processing
  assessment, prior consultation evidence, and DPIA update record.
- Processor controls: processor/vendor inventory, DPA, subprocessor list,
  processing instructions, and due-diligence review.
- Transfer controls: transfer inventory, SCCs, adequacy basis, transfer impact
  assessment, and supplementary safeguard evidence.
- Breach-response controls: personal data breach procedure, breach register,
  DPA notification decision tree, affected-individual template, and tabletop or
  incident evidence.

Use `record_control_request` for missing RoPA, privacy notice, lawful-basis
matrix, DPA/SCC, DPIA/screening, DSAR process/log, breach register, retention
schedule, DPO rationale, transfer inventory, processor inventory, or
controller/processor role evidence. Redact or reference personal data by
artifact/evidence handle; do not quote sensitive personal data into notes or
reports.
