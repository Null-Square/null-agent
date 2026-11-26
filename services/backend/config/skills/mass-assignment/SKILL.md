---
slug: mass-assignment
name: Mass Assignment Testing
description: "Detect unauthorized writable fields such as role, privilege, or status attributes. Use when: API accepts JSON objects for create/update operations."
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
use_when: Use when JSON/body APIs create or update users, accounts, roles, plans, status, ownership, pricing, permissions, or other server-side controlled fields.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Candidate writable-field map from observed requests, schemas, and responses
  - Mutation tests proving accepted, rejected, or silently ignored privileged fields
  - Impact-focused lead for unauthorized field persistence or state transition
evidence_floor: Mass-assignment confirmation requires before/after evidence that an unauthorized field was accepted and persisted or affected server-side behavior. Echoed request fields alone are insufficient.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - mass-assignment
  - mass assignment
  - overposting
  - role field
  - isadmin
  - hidden parameter
  - object binding
  - mass
  - assignment
tech_triggers:
  - graphql
  - rails
  - laravel
  - express
ntype_triggers:
  - http.parameters
  - http.endpoint
technique_ids:
  - B1:mass-assignment
  - OWASP-API3
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
# Mass Assignment Testing

## Attack Surface
Test whether backend model binding accepts sensitive fields that should be server-controlled.

## Discovery Methodology
1. Infer object schema from API responses.
2. Inject privileged and hidden fields into write operations.
3. Verify persistence via follow-up reads.
4. Document security impact and escalation path.

## Validation
Confirm only when server accepts and applies unauthorized field updates.
