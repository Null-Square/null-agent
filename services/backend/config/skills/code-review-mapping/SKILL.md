---
slug: code-review-mapping
name: Code Review Mapping
description: Maps architecture, trust boundaries, entry points, dependencies, and tests from a manifest-bound immutable commit.
phase: review_mapping
compatible_phases:
  - review_mapping
category: code_review
required_tools:
  - query_code_review_memory
  - record_code_review_memory
  - list_code_review_repository_files
  - search_code_review_repository
  - read_connected_repository_file
  - submit_phase_handoff
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use in review_mapping after a Code Review plan is approved.
not_when: Do not validate findings, report vulnerabilities, mutate source, or inspect paths outside the manifest.
required_inputs:
  - Immutable repository manifest
  - Approved path and context-read policy
expected_outputs:
  - Architecture and trust-boundary map
  - Explicit omissions and completeness
evidence_floor: Every mapped component must name at least one exact manifest path read at the bound commit.
follow_up_triggers:
  - Mapping identifies reachable security-sensitive entry points for analysis
strong_terms:
  - code review mapping
  - trust boundary map
  - immutable source map
tech_triggers: []
ntype_triggers: []
technique_ids:
  - CR:mapping
source_modes:
  - whitebox
related_skills:
  - code-review-analysis
handoff_skills:
  - code-review-analysis
mutation_applicability: not_applicable
mutation_not_applicable_reason: Mapping is read-only source inspection.
supporting_files:
  - fixtures/manifest.yaml
fixture_manifest: fixtures/manifest.yaml
---
# Code Review Mapping

Page through the complete bound manifest. Prioritize manifests, dependency
files, application entry points, request and job handlers, identity and
authorization controls, data-access layers, configuration, and relevant tests.
Every file selected for inspection must be read at the exact authorized
immutable SHA. Read only enough map-defining source to route the analysis
phase; do not turn mapping into a repository-wide line-by-line review. Handoff
the architecture map, coverage, omissions, and analysis priorities without
declaring findings.
Use bounded immutable search to locate callers, middleware, controls, and tests
whose paths cannot be derived reliably from the manifest alone.
Prior repository memory is a routing hint only. Re-read current source before
relying on it. Record only compact architectural facts verified at this
revision; the backend binds their path anchors and blob hashes.
