---
slug: business-logic
name: Business Logic Testing
description: "Find workflow and state machine flaws such as step skipping, value abuse, and rule bypass. Use when: endpoint-level security appears correct but process-level abuse is possible."
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - report_note
  - report_finding
  - submit_validation_lead_outcome
  - submit_validation_outcome
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Multi-step workflows, state transitions, payment or discount rules, entitlement checks, or process invariants are in scope and endpoint-level authorization appears correct while sequence or value abuse may still be possible.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Baseline valid workflow with expected step order and state transitions
  - Relevant roles, accounts, quantities, prices, discounts, or entitlement values
  - Durable before-and-after observations for the protected state or business rule
expected_outputs:
  - Reproducible accepted transition, replay, or value that should be rejected
  - Before-and-after state evidence showing business impact
  - Affected workflow, violated rule, and minimal reproduction sequence
evidence_floor: Confirm only when the system accepts a state transition, replay, or value that violates a documented or clearly inferred business rule, with durable evidence of the resulting impact.
follow_up_triggers:
  - Multi-step checkout, enrollment, approval, or subscription workflows appear
  - Price, quantity, discount, role, or entitlement values can be client-modified
  - Replay or step skipping changes workflow state
  - Individual endpoint checks pass but process-level invariants remain untested
strong_terms:
  - business-logic
  - business logic
  - workflow bypass
  - state machine
  - price tampering
  - cart manipulation
  - approval bypass
  - business
  - logic
tech_triggers:
  - ecommerce
  - fintech
  - subscription
ntype_triggers:
  - http.endpoint
technique_ids:
  - B1:business-logic
  - PS-BUSINESS
  - OWASP-API6
  - WSTG-BUSL
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
  - scripts/numeric_boundary_fuzz.py
fixture_manifest: fixtures/manifest.yaml
---
# Business Logic Testing

## Attack Surface
Evaluate end-to-end flows where security depends on sequence, rules, or business invariants.

## Discovery Methodology
1. Map workflow steps and required transitions.
2. Attempt step skipping and replay.
3. Test boundary and arithmetic abuse.
4. Verify financial, authorization, and process impact.

## Validation
Confirm when the system accepts a state transition or value that should be rejected by business rules.
