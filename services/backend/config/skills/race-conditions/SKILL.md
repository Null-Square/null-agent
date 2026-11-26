---
slug: race-conditions
name: Race Condition Testing
description: "Detect TOCTOU and concurrency flaws by sending parallel requests against state-sensitive endpoints. Use when: one-time actions or monetary operations are present."
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
use_when: Use when payment, coupon, invite, quota, transfer, redemption, order, upload, or state-transition endpoints may process concurrent requests without proper locking.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - State-sensitive endpoint inventory and concurrency hypothesis
  - Parallel request test results with timing, counts, and before/after state
  - Confirmed, rejected, or blocked outcome with non-destructive impact analysis
evidence_floor: Race-condition confirmation requires repeated or controlled concurrent execution that produces an impossible state, duplicate action, or bypass. A slow response alone is not evidence.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - race-conditions
  - race condition
  - toctou
  - double spend
  - parallel request
  - concurrency
  - race
  - conditions
  - condition
tech_triggers:
  - payment
  - ecommerce
  - distributed-locking
ntype_triggers:
  - http.endpoint
technique_ids:
  - B1:race-conditions
  - PS-RACE
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
  - scripts/race_burst.py
fixture_manifest: fixtures/manifest.yaml
---
# Race Condition Testing

## Attack Surface
Target operations that should be atomic and single-use under concurrent traffic.

## Discovery Methodology
1. Identify state-sensitive endpoints.
2. Send controlled parallel request bursts.
3. Measure repeated success where only one action should succeed.
4. Quantify impact with clear before/after state evidence.

## Validation
Confirm when concurrent requests bypass uniqueness, one-time, or balance invariants.
