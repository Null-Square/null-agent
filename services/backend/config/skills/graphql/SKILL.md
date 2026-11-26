---
# Portions adapted from Strix (https://github.com/usestrix/strix), Apache-2.0,
# Copyright 2025 OmniSecure Inc.; changed by NullSquare, Inc. See NOTICE.
slug: graphql
name: GraphQL Security Testing
description: "GraphQL-specific testing: resolver-level IDOR via aliases, batching abuse for rate-limit bypass, introspection/field-suggestion recon, directive bypass (@defer/@stream), federation entity injection via _entities, subscription auth, and persisted query abuse. Use when: /graphql or /api/graphql confirmed, Apollo/Hasura fingerprinted, or graphql tech_trigger fired."
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
use_when: Use when GraphQL endpoints, introspection responses, persisted query behavior, batched requests, resolver object IDs, or schema artifacts appear in inventory or scanner output.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - GraphQL endpoint inventory with schema/introspection status and auth posture
  - Resolver, batching, aliasing, and object-access tests with exact queries
  - Confirmed lead, false-positive outcome, or blocker for auth/rate/schema limitations
evidence_floor: GraphQL findings require exact query/mutation and response evidence showing unauthorized data access, control bypass, or abuse impact. Introspection alone is informational unless impact is proven.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - graphql
  - introspection
  - graphql schema
  - resolver
  - mutation
  - graphql endpoint
tech_triggers:
  - graphql
  - apollo
  - hasura
  - graphene
  - relay
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
technique_ids:
  - B1:graphql
  - PS-GRAPHQL
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
# GraphQL Security Testing

## Attack Surface
Schema introspection, resolver field-level authorization, mutations, subscriptions,
federation subgraph boundaries, persisted queries, and file upload scalars.

## Discovery Methodology
1. Fingerprint via `{__typename}` probe; confirm endpoint and transport (HTTP/WebSocket/multipart).
2. Extract full schema via introspection; if blocked, infer via field suggestions and error taxonomy.
3. Build principal matrix: unauth, user, admin tokens with known object IDs per role.
4. Test resolver auth per field — probe parent vs child enforcement gaps using aliases.
5. Probe federation: `_service` SDL exposure, `_entities` cross-subgraph materialization.

## Mutation Algebra
- Aliased owned vs foreign ID in single request (cross-user IDOR without multiple HTTP calls)
- Extra fields in input objects passed to downstream resolvers
- Directive bypass: `@defer`/`@stream` on gated field sets
- Transport switching: `application/json` vs `application/graphql` vs `multipart/form-data`
- Fragment splitting and inline spreads to evade WAF payload signatures

## Validation
Confirm resolver returns foreign object fields, federation `_entities` delivers
cross-tenant data without subgraph-level auth, or `@defer` delivers gated content
in incremental stream.
