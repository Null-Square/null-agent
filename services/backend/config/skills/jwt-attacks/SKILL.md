---
slug: jwt-attacks
name: JWT Attack Testing
description: "JWT attack testing — algorithm confusion (alg:none, HS256/RS256 confusion), kid header path traversal, claim tampering, signature stripping, replay. Use when: Authorization: Bearer present, Node.js/Java/Python detected, credential.found notes exist, or login returns a JWT."
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
use_when: Use when JWTs, JWK/JWKS endpoints, bearer tokens, OAuth/OIDC flows, signed cookies, or authorization claims appear in requests, storage, or documentation.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Token structure, signing metadata, key source, and claim trust-boundary analysis
  - Tested algorithm, key confusion, expiry, audience, issuer, and claim-tampering cases
  - Confirmed, rejected, or blocked validation outcome with exact token/request evidence
evidence_floor: JWT findings require a modified or misvalidated token that changes authorization, identity, or access outcome. Decoding a token or observing weak-looking claims is not enough.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - jwt-attacks
  - jwt
  - jwk
  - jwks
  - alg none
  - kid header
  - token replay
  - claim tampering
  - attacks
  - attack
tech_triggers:
  - node.js
  - java
  - python
ntype_triggers:
  - http.headers
  - credential.found
technique_ids:
  - B1:jwt-attacks
  - PS-JWT
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
# JWT Attack Testing

## Attack Surface
Inspect token issuance, verification, key management, and claim enforcement across services.

## Discovery Methodology
1. Identify accepted algorithms and key types.
2. Check signature verification strictness and key confusion risks.
3. Validate claim handling (`aud`, `iss`, `exp`, `nbf`, `kid`).

## Mutation Algebra
- Algorithm confusion (`none`, HS/RS confusion attempts)
- Header abuse (`kid` path traversal, key lookup injection)
- Claim tampering with boundary values
- Clock-skew and replay edge cases

## Validation
Confirm when token manipulation leads to unauthorized privilege or identity escalation.
