---
slug: tooling-gitleaks
name: Gitleaks Operation
description: Run Gitleaks secret scanning with JSON output and redacted evidence.
phase: validation
compatible_phases:
  - validation
category: tooling
required_tools:
  - shell_run
  - wait_for_shell_job
  - ingest_scan_artifact
  - file_read
  - report_note
tool_alternatives: []
risk_tier: low
use_when: Use for repository or filesystem secret exposure review.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Repository or filesystem path
expected_outputs:
  - JSON artifact ingested with ingest_scan_artifact(parser="gitleaks")
evidence_floor: Keep the JSON artifact with redacted secret values, source path, rule ID, and verification status. Never expose full secrets in model context or reports.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - tooling-gitleaks
  - gitleaks
  - secret scanning
  - git secrets
  - credential leak
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:tooling-gitleaks
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
# Gitleaks Operation

Use Gitleaks for repository and filesystem secret scanning.
