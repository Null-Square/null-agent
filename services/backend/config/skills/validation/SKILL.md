---
slug: validation
name: Independent Risk Validation
description: Fresh-context validation methodology for confirming or dismissing potential Risks.
phase: validation
compatible_phases:
  - validation
category: validation
required_tools:
  - query_notes
  - submit_validation_lead_outcome
  - submit_validation_outcome
  - file_read
tool_alternatives: []
risk_tier: standard
freshScopePriority: medium
use_when: "Two assignment paths: (1) the planner assigns this skill to a validation mission that verifies a specific potential Risk (set revalidates_finding_id on the mission and pair with the matching class skill); (2) a validator_worker session is spawned automatically from promote_finding for a specific Risk ID and inherits this skill's methodology. Use whenever a potential Risk must be reproduced in a fresh context with no parent-evidence trust before it becomes confirmed and reportable."
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Target Risk ID
  - query_findings output for that Risk
  - In-scope asset and endpoint context
  - The matching class skill paired in assigned_skills
expected_outputs:
  - Durable validator-session evidence for confirmed Risks
  - submit_validation_outcome with validated, false_positive, or inconclusive
evidence_floor: Validation requires independent reproduction, exact evidence refs, and an explicit validated, false_positive, inconclusive, or blocked outcome. Parent claims or scanner output alone are not sufficient.
follow_up_triggers:
  - On validated outcome, Risk becomes confirmed and reportable; reporting phase consumes it
  - On false_positive outcome, Risk becomes dismissed and is excluded from the report
  - On inconclusive outcome, Risk stays verifying and surfaces for human triage
strong_terms:
  - reproduce
  - confirm
  - false positive
  - evidence floor
  - validation lead
  - independent
  - finding
tech_triggers: []
ntype_triggers:
  - finding.candidate
  - approach.tried
technique_ids:
  - B1:validation
  - STRIX-VULN
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - security-reporting
handoff_skills:
  - security-reporting
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
fixture_manifest: fixtures/manifest.yaml
---
# Independent Risk Validation

Validation is not report writing. It is an isolated yes/no reproduction attempt.
