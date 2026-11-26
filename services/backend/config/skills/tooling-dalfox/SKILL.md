---
slug: tooling-dalfox
name: Dalfox Operation
description: Run Dalfox XSS checks with JSON output and manual confirmation.
phase: validation
compatible_phases:
  - validation
  - enumeration
category: tooling
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - file_read
  - report_note
tool_alternatives: []
risk_tier: low
use_when: Use after parameters or reflected inputs are mapped.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - URL or parameter list
expected_outputs:
  - JSON artifact ingested with ingest_scan_artifact(parser="dalfox")
evidence_floor: Keep the Dalfox JSON artifact, command line, target list, and any replayable payload evidence. Treat scanner hits as candidates until manually confirmed with request/response proof.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - tooling-dalfox
  - dalfox
  - xss scanner
  - dalfox json
  - reflected xss
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:tooling-dalfox
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - validation
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
fixture_manifest: fixtures/manifest.yaml
---
# Dalfox Operation

Use Dalfox as a signal generator, then confirm execution manually.
