---
slug: api-enumeration
name: API Surface Enumeration
description: "Discover hidden APIs through spec discovery, route brute force, and method mapping. Use when: auth walls block known paths, API prefixes are visible, or no complete endpoint map exists."
phase: enumeration
compatible_phases:
  - enumeration
  - recon
category: enumeration
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - report_note
  - query_inventory
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when API route, method, or schema coverage is incomplete, when OpenAPI/Swagger/GraphQL clues appear, or when visible API prefixes need deterministic enumeration before vulnerability testing.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Confirmed API routes, methods, schemas, and documentation endpoints with evidence refs
  - Parameter, auth, versioning, and content-type observations suitable for endpoint inventory
  - Coverage notes for discovered, blocked, and deferred API enumeration paths
evidence_floor: Provide durable command output or ingested artifacts for discovered API routes/specs, plus explicit blocked coverage for auth, rate-limit, scope, or parser gaps. Do not infer complete API coverage from a single route response.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - api-enumeration
  - api
  - openapi
  - swagger
  - graphql
  - rest
  - endpoint enumeration
  - api schema
  - route inventory
  - enumeration
  - surface
tech_triggers:
  - graphql
  - swagger
  - openapi
ntype_triggers:
  - http.endpoint
technique_ids:
  - B1:api-enumeration
  - PS-API
  - OWASP-API9
  - WSTG-APIT
  - STRIX-PROTOCOL
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - broad-surface-scan
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
# API Surface Enumeration

## Attack Surface
Find API routes, versions, methods, and schemas before deep vulnerability testing.

## Discovery Methodology
1. Probe common doc/spec endpoints.
2. Enumerate routes with API-focused wordlists.
3. Map allowed methods and auth behavior per endpoint.
4. Feed validated endpoints back into inventory notes.

## Validation
Confirm with HTTP response evidence and endpoint-level method support.
