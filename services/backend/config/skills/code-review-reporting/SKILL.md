---
slug: code-review-reporting
name: Code Review Reporting
description: Finalizes a standalone Code Review report from canonical validated findings and immutable source attribution.
phase: review_reporting
compatible_phases:
  - review_reporting
category: code_review
required_tools:
  - record_code_review_memory
  - query_code_review_findings
  - finalize_code_review_report
  - submit_phase_handoff
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Use after Code Review validation resolves every candidate.
not_when: Never use Pentest report tools, perform new analysis, publish GitHub feedback, or generate fixes.
required_inputs:
  - Canonical validated and rejected Code Review outcomes
  - Immutable repository context and coverage limitations
expected_outputs:
  - Standalone canonical Code Review report
  - Final review_reporting handoff
evidence_floor: Every reported finding must come from canonical validated Code Review storage with exact immutable source locations.
follow_up_triggers:
  - A validated fixable finding may expose the separate user-controlled fix action
strong_terms:
  - code review report
  - source review findings
  - immutable report
tech_triggers: []
ntype_triggers: []
technique_ids:
  - CR:reporting
source_modes:
  - whitebox
related_skills:
  - code-review-validation
handoff_skills: []
mutation_applicability: not_applicable
mutation_not_applicable_reason: Reporting renders canonical read-only review results.
supporting_files:
  - fixtures/manifest.yaml
fixture_manifest: fixtures/manifest.yaml
---
# Code Review Reporting

Query canonical Code Review outcomes. Summarize the immutable repository,
revision, reviewed path set, validated findings, rejected candidates, coverage,
omissions, and limitations. Call `finalize_code_review_report` with an honest
`complete`, `partial`, or `blocked` review-completeness decision; complete
manifest retrieval does not itself mean review coverage was complete. It
renders validated findings from canonical storage. Then submit the phase
handoff. Never call Pentest finalizers or publication tools.
Optionally record one bounded review.coverage memory after report finalization;
memory failure must not replace or invalidate the canonical report.
