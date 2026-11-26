---
slug: code-review-planning
name: Code Review Planning
description: Plans the four-phase standalone Code Review workflow from one immutable repository and manifest context.
phase: planning
compatible_phases:
  - planning
category: code_review
required_tools:
  - list_code_review_repository_files
  - search_code_review_repository
  - read_connected_repository_file
  - submit_plan
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use only in a standalone Code Review planner session with a valid immutable typed context.
not_when: Never use for Pentest, Compliance, live-target testing, repository mutation, or a missing or incomplete authority context.
required_inputs:
  - Immutable Code Review repository context
  - Manifest-bound file list
expected_outputs:
  - Exactly four ordered missions for review_mapping, review_analysis, review_validation, and review_reporting
evidence_floor: Every mission must cite the bound repository, immutable commit, manifest, path policy, and an explicit completion condition.
follow_up_triggers:
  - The immutable manifest is available and at least one in-scope file can be read
strong_terms:
  - code review planning
  - immutable repository review
  - source review plan
tech_triggers: []
ntype_triggers: []
technique_ids:
  - CR:planning
source_modes:
  - whitebox
related_skills:
  - code-review-mapping
  - code-review-analysis
  - code-review-validation
  - code-review-reporting
handoff_skills:
  - code-review-mapping
mutation_applicability: not_applicable
mutation_not_applicable_reason: Planning defines an immutable read-only workflow and does not mutate source or exploit inputs.
supporting_files:
  - fixtures/manifest.yaml
fixture_manifest: fixtures/manifest.yaml
---
# Code Review Planning

Treat the typed context as the entire authority boundary. Call
`list_code_review_repository_files`, use bounded
`search_code_review_repository` when a literal symbol or control needs to be
located, and inspect only enough immutable source to
choose bounded review objectives, then submit exactly these phases in order:

1. `review_mapping`
2. `review_analysis`
3. `review_validation`
4. `review_reporting`

The server owns the fixed phase-to-skill routing. Do not choose `skillSlugs` or
`assigned_skills`, and do not browse the global skill catalog. Never introduce
Pentest or Compliance phases or skills. Never plan patches, branches, commits,
pull requests, publication, or live-target tests.
