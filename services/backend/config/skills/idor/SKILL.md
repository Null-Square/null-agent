---
slug: idor
name: IDOR and BOLA Testing
description: "IDOR/BOLA testing — horizontal and vertical privilege escalation across object references. Cross-account access via ID swapping, tenant header manipulation, UUID harvesting. Use when: REST APIs with numeric or UUID resource IDs, multi-tenant applications, or user-owned resource endpoints present."
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
use_when: REST APIs expose numeric, UUID, slug, tenant, account, or document identifiers in paths, query strings, headers, or request bodies, especially in multi-tenant or user-owned resource flows.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Baseline authorized request and response for the object-owning user
  - Second user, tenant, or comparable authorization context when available
  - Endpoint, parameter, header, or body field carrying the object reference
expected_outputs:
  - Reproducible cross-account read, write, or delete proof
  - Side-by-side authorized and unauthorized request/response evidence
  - Affected route, resource type, reference field, and impacted authorization boundary
evidence_floor: Unauthorized read, write, or delete must be reproducible against another user's resource, with durable HTTP evidence or artifact proof showing the bypass and impact.
follow_up_triggers:
  - User-owned resource IDs appear in routes, query strings, or bodies
  - Tenant, organization, account, or owner headers influence access
  - UUIDs or numeric IDs are discoverable from adjacent endpoints
  - Write, update, or delete methods exist on the same resource family
strong_terms:
  - idor
  - bola
  - object authorization
  - horizontal privilege
  - tenant id
  - user id
  - resource id
tech_triggers:
  - rest
  - graphql
ntype_triggers:
  - http.parameters
  - http.endpoint
technique_ids:
  - B1:idor
  - OWASP-API1
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
# IDOR / BOLA Testing

## Attack Surface
Locate endpoints where object references are user-controlled (numeric IDs, UUIDs, slugs, tenant IDs).

## Discovery Methodology
1. Establish two identities/tenants when possible.
2. Swap object references across identities.
3. Compare authorization behavior and data leakage.

## Mutation Algebra
- ID sequencing (`1001 -> 1002`) and sparse guessing
- UUID reuse from other endpoints
- Tenant/organization header and parameter swapping
- Method pivots (`GET/PUT/PATCH/DELETE`) on same resource

## Validation
Confirm when unauthorized read/write/delete is reproducible for another user's resource.
