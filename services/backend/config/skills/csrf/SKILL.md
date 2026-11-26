---
slug: csrf
name: CSRF Testing
description: "Validate CSRF protection on state-changing operations, token handling, and origin checks. Use when: cookie-based authentication is present or browser actions change account state."
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
use_when: Use when state-changing browser endpoints rely on cookies or ambient credentials and there is uncertainty about CSRF tokens, SameSite posture, Origin/Referer checks, or preflight enforcement.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - List of tested state-changing operations and their anti-CSRF controls
  - Reproduction or rejection evidence for cross-site request execution
  - Coverage notes for methods blocked by auth, CORS, SameSite, or missing account state
evidence_floor: A CSRF issue needs a durable cross-origin request proof that changes state or reaches the sensitive action without a valid anti-CSRF secret. Token presence alone is not proof of safety or weakness.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - csrf
  - cross-site request forgery
  - anti-csrf
  - same-site
  - state changing request
tech_triggers:
  - spring
  - django
  - rails
  - laravel
ntype_triggers:
  - http.endpoint
  - http.parameters
technique_ids:
  - B1:csrf
  - PS-CSRF
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
fixture_manifest: fixtures/manifest.yaml
---
# CSRF Testing

## Attack Surface
Check all authenticated actions that modify user or system state.

## Discovery Methodology
1. Enumerate state-changing endpoints.
2. Validate token, origin, and referer controls.
3. Test token bypass and content-type edge cases.
4. Confirm impact with controlled account actions.

## Validation
Confirm only when a forged cross-site request succeeds without intended anti-CSRF controls.
