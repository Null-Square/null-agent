---
slug: compliance-planning
name: Compliance Assessment Planning
description: Planner-only skill for dedicated compliance assessment runs.
phase: planning
compatible_phases:
  - planning
category: compliance
required_tools:
  - query_inventory
  - query_findings
  - submit_plan
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use only when the run is a dedicated compliance assessment. It produces a readiness mission graph for monitored controls in the selected framework, not a vulnerability hunting plan.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - query_compliance_readiness output for the selected scope and framework
  - query_inventory output for the tested scope
  - Optional query_findings output as related signals only
expected_outputs:
  - Exactly one control_assessment mission assigned to the compliance skill(s) needed for the monitored controls
  - Exactly one reporting mission assigned to compliance-reporting
  - skillSlugs containing only compliance-access-control, compliance-technical-readiness, compliance-evidence-review, compliance-governance-review, and compliance-reporting
evidence_floor: When TARGET CONTEXT supplies explicit controls, the plan must target every selected control and proof obligation. When TARGET CONTEXT supplies monitored controls, the plan must cover every monitored control by requiring either a fresh record_control_check, review_control_request for fulfilled evidence, or record_control_request for missing evidence/access/context/ remediation before handoff.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - compliance-planning
  - compliance
  - governance review
  - policy review
  - technical control
  - access control
  - evidence review
  - proof obligation
  - record_control_check
  - record_control_request
  - planning
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:compliance-planning
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills: []
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
# Compliance Readiness Assessment Planning

This planner does not schedule a pentest. It schedules selected-framework
readiness work.

Required plan shape:

1. A `control_assessment` mission assigned only to the compliance skills needed
   for the monitored controls:
   - `compliance-access-control` for access-control, authentication,
     authorization, privileged-access, and tenant/object-boundary controls.
   - `compliance-technical-readiness` for transport, monitoring, scanner,
     attack-surface, vulnerability-detection, SDLC, supply-chain, network, and
     security-event controls.
   - `compliance-evidence-review` for explicit controls with
     `evidence-review:*` obligations or uploaded/integration evidence.
   - `compliance-governance-review` for policy ownership, risk management,
     oversight, management review, internal review, corrective action,
     supplier governance, and continuity governance evidence.
   - multiple skills only when the chosen controls span groups.
2. A `reporting` mission assigned only to `compliance-reporting`.

Do not create a separate recon mission. If selected technical controls need
inventory orientation, keep that bounded work inside `control_assessment` and
record a request when the required inventory source is unavailable.

For HIPAA runs, plan across the selected Security Rule safeguards in TARGET
CONTEXT: Administrative, Physical, Technical, and Organizational. Preserve
`implementationSpec` semantics in the mission text: Required safeguards need
direct supporting evidence or a request, Addressable safeguards need implemented
control evidence or documented risk-based alternative evidence, and Mixed
standards need the checked portions and remaining gaps stated clearly.

For PCI DSS runs, plan from the selected PCI DSS v4.0.1 controls in TARGET
CONTEXT and preserve PCI metadata in the mission text: requirement, CDE scope,
SAQ applicability, account-data type, and approach. Start by looking for the
declared CDE boundary and SAQ/profile context in organization context, scope
RoE, inventory tags, or uploaded evidence. If either is missing, require a
specific `record_control_request` and mark the relevant controls as unscoped or
profile-unconfirmed rather than inferring the answer. Do not claim ASV, QSA,
ROC, SAQ, AOC, or PCI compliance status. Do not store or reproduce real PAN or
sensitive authentication data.

The control_assessment mission must explicitly name:

- framework: selected framework
- controls: every selected or monitored control id supplied in TARGET CONTEXT
- proof obligations: every matching proof obligation id supplied in TARGET CONTEXT
- required canonical writes:
  - `record_control_check` for controls you can honestly test or evidence-review now
  - `review_control_request` for fulfilled requests you review
  - `record_control_request` for missing evidence, access, context, or remediation

When TARGET CONTEXT contains many monitored controls, prioritize execution order
inside the one assessment mission this way:

1. stale or never-checked controls;
2. fulfilled evidence requests waiting for review;
3. controls with inventory, scanner, finding, note, or HTTP evidence already available;
4. direct technical checks that are feasible now;
5. missing manual/integration evidence that needs a concrete request.

Do not leave monitored controls silent. If a control cannot be tested or reviewed
now, the assessment mission must require `record_control_request` for the missing
input instead of deferring it.

Related findings can inform targeting, but they do not create a pass/fail
control verdict. The assessment worker owns the verdict after fresh evidence.
