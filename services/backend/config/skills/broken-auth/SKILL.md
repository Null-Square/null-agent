---
slug: broken-auth
name: Broken Authentication Testing
description: "Broken authentication testing — credential stuffing controls, password reset token flaws, session fixation, MFA bypass, multi-step auth flow skip, concurrent request races. Use when: login/reset/MFA/session endpoints present, OAuth/OIDC/JWT detected, or credential.found notes exist."
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
use_when: Use when login, registration, password reset, MFA, session, token, or account recovery flows are present or when a lead references authentication bypass, weak controls, or account-state confusion.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Mapped auth flow and trust boundaries with exact requests and responses
  - Confirmed or falsified auth-control weakness with before/after evidence
  - Blocked prerequisite record when valid accounts, MFA, or source context are unavailable
evidence_floor: Authentication findings require reproducible request/response evidence showing the control failure and impact. Missing credentials or account state must be recorded as a blocker, not stretched into a finding.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - broken-auth
  - broken auth
  - authentication bypass
  - login bypass
  - session fixation
  - password reset
  - mfa bypass
  - oauth
  - sso
  - broken
  - auth
  - authentication
tech_triggers:
  - oauth
  - oidc
  - jwt
ntype_triggers:
  - http.endpoint
  - credential.found
technique_ids:
  - B1:broken-auth
  - PS-AUTH
  - OWASP-API2
  - WSTG-IDNT
  - WSTG-ATHN
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
  - scripts/.gitkeep
fixture_manifest: fixtures/manifest.yaml
---
# Broken Authentication Testing

## Attack Surface
Review credential flows, password reset, MFA, session issuance, and logout invalidation.

## Discovery Methodology
1. Test credential stuffing controls and lockout behavior safely.
2. Validate reset token scope, expiry, and one-time use.
3. Assess session fixation and token invalidation paths.

## Mutation Algebra
- Replay and race condition variants
- Token lifecycle edge-case timing
- Identifier confusion across usernames/emails/phone
- Multi-step flow skipping and state desynchronization

## Validation
Confirm when unauthorized account access, session hijack, or auth bypass is reproducible.
