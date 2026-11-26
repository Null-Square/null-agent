---
slug: code-review-validation
name: Code Review Validation
description: Independently falsifies current-run source candidates and records validated or rejected outcomes plus agent-owned fixability.
phase: review_validation
compatible_phases:
  - review_validation
category: code_review
required_tools:
  - query_code_review_memory
  - record_code_review_memory
  - query_code_review_findings
  - search_code_review_repository
  - read_connected_repository_file
  - validate_code_review_finding
  - submit_phase_handoff
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use after analysis persists candidates for the immutable review revision.
not_when: Do not validate from title or pattern alone, run live attacks, create patches, or leave a candidate unresolved.
required_inputs:
  - Current-run candidates
  - Exact immutable source and relevant controls or tests
expected_outputs:
  - Validated or rejected disposition for every candidate
  - Fixable, not_fixable, or uncertain judgment for each validated finding
evidence_floor: Validation must trace reachability and the relevant guard or negative control at the authorized immutable revision.
follow_up_triggers:
  - All candidates have a terminal outcome and reporting can begin
strong_terms:
  - code review validation
  - falsify source finding
  - fixability decision
tech_triggers: []
ntype_triggers: []
technique_ids:
  - CR:validation
source_modes:
  - whitebox
related_skills:
  - code-review-analysis
  - code-review-reporting
handoff_skills:
  - code-review-reporting
mutation_applicability: not_applicable
mutation_not_applicable_reason: Validation reads immutable source and records a canonical outcome without modifying code.
supporting_files:
  - fixtures/manifest.yaml
fixture_manifest: fixtures/manifest.yaml
---
# Code Review Validation

Query every candidate, retain its exact current version, and try to disprove it.
Trace complete relevant paths,
guards, caller constraints, state, and tests. Record `validated` only when the
security impact is supported; otherwise record `rejected`.
Require affirmative authorized evidence for claims that a security control is
absent. Unseen callers, middleware, deployment configuration, or operational
controls are unknown, not missing. Record the coverage limitation and reject a
candidate when its reachability or impact depends on assuming an out-of-scope
control does not exist.
In pull-request review, reject `pre_existing_context` candidates as outside the
changed-code finding set; only introduced, exposed, or worsened behavior may be
validated as a PR finding.

The agent owns the fixability judgment. Choose `fixable` only when a bounded
safe change is clear, and provide rationale, expected files, and a validation
plan. Choose `uncertain` when safe change boundaries are unclear. The phase
cannot close while any candidate remains unresolved. Every
`validate_code_review_finding` call must include the queried `findingVersion`;
if it is stale, query again instead of overwriting a newer candidate.
After the canonical outcome is stored, optionally preserve a compact
source-anchored disposition. Never validate or reject from memory alone.
