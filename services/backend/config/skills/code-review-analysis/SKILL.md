---
slug: code-review-analysis
name: Code Review Analysis
description: Performs source-first security analysis and persists candidates with backend-verified immutable code locations.
phase: review_analysis
compatible_phases:
  - review_analysis
category: code_review
required_tools:
  - query_code_review_memory
  - search_code_review_repository
  - read_connected_repository_file
  - query_code_review_findings
  - report_code_review_candidate
  - submit_phase_handoff
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use after mapping identifies reachable security-sensitive source paths.
not_when: Never treat pattern matches as validated findings, attack a live target, or generate a patch.
required_inputs:
  - Review mapping handoff
  - Immutable source files and tests
expected_outputs:
  - Deduplicated source-attributed candidates
  - Uncovered-area list
evidence_floor: A candidate requires a reachable security claim plus an exact source anchor copied from an authorized immutable SHA; the backend resolves and verifies its line range.
follow_up_triggers:
  - At least one candidate is ready for independent falsification
strong_terms:
  - code review analysis
  - source candidate
  - data flow
tech_triggers: []
ntype_triggers: []
technique_ids:
  - CR:analysis
source_modes:
  - whitebox
related_skills:
  - code-review-mapping
  - code-review-validation
handoff_skills:
  - code-review-validation
mutation_applicability: not_applicable
mutation_not_applicable_reason: Analysis traces immutable source and records candidates without mutating code.
supporting_files:
  - fixtures/manifest.yaml
fixture_manifest: fixtures/manifest.yaml
---
# Code Review Analysis

Trace sources to sinks and authorization, validation, encoding, secret,
dependency, configuration, and state-transition controls. Prefer reachable
paths over isolated suspicious lines. Query current-run candidates before
writing. Use bounded immutable literal search to locate callers, guards, and
negative controls. Use `report_code_review_candidate` only when an exact,
case-sensitive source anchor copied from the repository read contains the
relevant source, guard, or sink. Never count or guess line numbers; the backend
resolves the range and hashes the cited source. If the same anchor appears more
than once, provide its 1-based occurrence. For a
pull-request review, classify the change as `introduced`, `exposed`,
`worsened`, or `pre_existing_context` and explain the attribution. A
pre-existing contextual issue is not a changed-code finding.
Do not infer that middleware, caller, deployment, or operational controls are
absent merely because the authorized changed-path context cannot show them.
Treat such controls as unknown and record the coverage limitation. Persist a
candidate only when the immutable source establishes a concrete reachable
weakness and security impact without relying on out-of-scope absence.
Prior memory may suggest a path to inspect but cannot prove or disprove a
candidate and must never suppress fresh analysis.
