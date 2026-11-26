---
slug: open-redirect
name: Open Redirect Testing
description: "Open redirect testing — URL allowlist bypass, scheme-relative forms, backslash confusion, URL parser mismatch exploitation, OAuth return_url and post-login redirect abuse. Use when: redirect/next/return_url parameters present, OAuth/OIDC login flows, or post-auth navigation endpoints in scope."
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
use_when: Use when redirect parameters, return URLs, OAuth callbacks, SSO flows, logout links, deep links, or URL allowlists are present or inferred.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Redirect sink inventory with parameter names and allowlist behavior
  - Payload tests for absolute, scheme-relative, encoded, backslash, and host-confusion bypasses
  - Impact disposition for phishing, token leakage, OAuth abuse, or benign redirects
evidence_floor: Open redirect confirmation requires an exact URL that redirects to an attacker-controlled destination under realistic conditions. Low-impact same-site redirects should be marked as coverage.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - open-redirect
  - open redirect
  - redirect_uri
  - next url
  - return url
  - callback url
  - url parameter
  - open
  - redirect
tech_triggers:
  - oauth
  - oidc
ntype_triggers:
  - http.parameters
  - http.endpoint
technique_ids:
  - B1:open-redirect
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
# Open Redirect Testing

## Attack Surface
Find endpoints that accept destination URLs or route names for redirects.

## Discovery Methodology
1. Test absolute and relative URL handling.
2. Evaluate allowlist logic and parser mismatches.
3. Chain with auth flows where applicable.

## Mutation Algebra
- Scheme-relative forms (`//attacker.tld`)
- Backslash and mixed slash forms
- URL parser confusion (`@`, encoded delimiters, nested URLs)
- Hostname lookalike and subdomain bypasses

## Validation
Confirm when user navigation can be forced to attacker-controlled domains despite intended restrictions.
