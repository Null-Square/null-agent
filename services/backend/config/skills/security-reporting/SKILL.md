---
slug: security-reporting
name: Security Reporting
description: "Closeout reporting discipline for SecurityOps runs. Drives the executor through a real pentest deliverable shape: executive summary, methodology, attack surface, per-finding analysis, limitations, remediation plan, and next steps — every claim backed by canonical findings, notes, HTTP exchanges, or artifact paths."
phase: reporting
compatible_phases:
  - reporting
category: reporting
required_tools:
  - report_finalizer_preflight
  - prepare_report_context
  - file_write
  - submit_phase_handoff
  - finalize_run_artifacts
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Always assigned to the final closeout mission of a normal SecurityOps run. Triggered when testing missions are complete and the executor must turn canonical evidence into manually authored `summary.md` and `report.md` before finalize_run_artifacts validates the closeout.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Approved plan and mission envelopes
  - Canonical report_finding and promote_finding state for this scope
  - Evidence artifact paths and HTTP exchange references
expected_outputs:
  - report_finalizer_preflight call that writes `.artifacts/report/finalizer-preflight.json` and decides whether the closeout must be final or interim before drafting
  - prepare_report_context call that writes `.artifacts/report/brief.md` and `.artifacts/report/context.json`
  - One report.section per pentest-report block — executive-summary, methodology, attack-surface, findings-narrative, limitations, remediation-plan, next-steps — for the slugs that this run's evidence actually supports
  - One run.digest with goal, outcome, recommendation, blocker_summary, completed/blocked tasks, and next prerequisites
  - Authored `summary.md` and `report.md` in the workspace root
  - finalize_run_artifacts call (mode="final" when RunCompletion is ready, otherwise mode="interim" with a concrete reason)
evidence_floor: Every security claim in a report.section must cite a canonical finding ID, note title, HTTP exchange, or artifact path via evidence_refs. Never make a claim that cannot be traced back to durable evidence — sections without citations weaken the report and fail the reviewer test.
follow_up_triggers:
  - Multiple findings require executive prioritization
  - A run has blocked coverage that management must understand
  - The operator needs remediation handoff or a formal assessment artifact
strong_terms:
  - security-reporting
  - reporting
  - final report
  - summary.md
  - report.md
  - run digest
  - finalize
tech_triggers: []
ntype_triggers:
  - report.section
  - run.digest
  - approach.tried
  - scan.coverage
technique_ids:
  - B1:security-reporting
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills: []
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
fixture_manifest: fixtures/manifest.yaml
---
# Security Reporting

Reporting is its own phase, not a side effect of stopping. The reporter
authors a pentest-shaped `report.md` and compact `summary.md` from the
canonical report context. `prepare_report_context` gives you durable source
material; `report_finalizer_preflight` tells you whether final mode can pass;
`finalize_run_artifacts` validates and publishes the authored files but does
not write report prose for you.

## Section Notes

`report.section` notes are optional durable source material for long runs.
Use these slugs when you need to preserve analyst narrative before authoring
the final files. Do not expect the finalizer to place these notes into the
report automatically.

| section slug         | Suggested report use              | What to put here                                                                                       |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `executive-summary`  | §1. Executive Summary             | Business-readable verdict: scope tested, risk posture, top findings, overall recommendation. 4–8 sentences. |
| `methodology`        | §3. Engagement Methodology        | Plan phases, skills exercised, manual techniques, scanners, meaningful pivots, and why each was chosen. |
| `attack-surface`     | §4. Attack Surface Overview       | Hosts, services, auth boundaries, technology stack observations, trust-boundary notes.                 |
| `findings-narrative` | Findings Narrative                | Cross-finding synthesis: themes, chained risk, root-cause patterns. Keep per-finding detail in the authored report only when it matters. |
| `limitations`        | §6. Limitations and Coverage Debt | Blocked tests, missing credentials, scanner failures, untested classes, network-origin limits.         |
| `remediation-plan`   | §7. Remediation Plan              | Prioritized fix sequencing, ownership hints, dependencies between fixes, quick wins vs. structural.    |
| `next-steps`         | §8. Next Steps                    | Highest-value agent-actionable assessment path: class, target, and why it is likely to produce findings. Not remediation, credentials, or "continue testing". |

Any other `section` value is allowed but should be rare. The final report is
still written manually from the prepared context and useful section notes.

## Hard Rules

- **Evidence-bound.** Every security claim must cite canonical evidence in
  `evidence_refs` (finding ID, note title, HTTP exchange, or artifact path).
  Missing citations are a visible quality problem for the reporter.
- **Findings move only through `report_finding` and `promote_finding`.**
  Sections cite findings; they never validate or downgrade them.
- **Don't dump per-finding rows.** The `findings-narrative` section is for
  cross-finding synthesis. Put only the per-finding detail that a reader needs
  in the authored `report.md`.
- **Don't paste raw context.** Scanner jobs, technique attempts, and evidence
  indexes belong in `.artifacts/report/context.json` unless they are essential
  to the reader's understanding.
- **Skip what evidence cannot back.** A missing section is honest. A padded
  section is worse than no section.
- **No compliance reporting in this skill.** A normal SecurityOps report may
  say that findings can inform future readiness work, but it must not include
  SOC 2, HIPAA, PCI, ISO, NIST, readiness-score, or control-matrix sections.
  Dedicated readiness reports use the `compliance-reporting` skill.
- **Mermaid where it clarifies, not decorates.** A small attack-surface
  map, evidence-flow map, or validation-sequence diagram inside the
  matching section helps a reader. Skip diagrams for trivial cases.
- **Length.** A section over ~1500 characters usually belongs in the authored
  report, not as a durable note. Trim notes toward analyst voice.

## Phase Flow

1. Inventory canonical state with `query_findings`, `query_inventory`, and
   `query_notes` for `approach.tried`, `approach.blocker`, and
   `scan.coverage`.
2. Call `report_finalizer_preflight`. Draft a final report only when it
   returns `canFinalizeFinal=true`; otherwise draft an interim closeout and
   carry the blockers into `run.digest`.
3. Call `prepare_report_context` and read `.artifacts/report/brief.md`.
4. Decide which sections this run's evidence supports. Skip what it cannot.
5. Optionally write `report.section` notes for durable narrative fragments.
6. Write one `run.digest` after the final coverage state is clear. Its
   `recommendation`, when present, must be a next assessment objective the
   agent can execute with current scope data and tools.
7. Author `summary.md` and `report.md` manually with `file_write`.
8. Call `finalize_run_artifacts` (mode="final" or "interim" with reason).

The reporter owns `summary.md` and `report.md`. The finalizer validates them.

See `methodology.md` for the full per-section playbook, evidence-citation
patterns, and Mermaid templates.
