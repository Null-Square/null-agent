---
slug: tooling-interactsh
name: OOB Interaction Operation
description: Use first-class OOB tokens for blind callback validation.
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
use_when: Use for blind SSRF, XXE, RCE, log injection, and DNS exfil checks.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Target endpoint and payload injection point
expected_outputs:
  - OOB token and interaction evidence
evidence_floor: Keep token IDs, callback timestamps, source payload refs, and affected endpoint context. OOB callbacks must be tied to the exact request that triggered them.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - tooling-interactsh
  - interactsh
  - oast
  - out-of-band
  - callback
  - blind ssrf
  - oob
  - interaction
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:tooling-interactsh
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
# OOB Interaction Operation

Use `oob_token_create` and `oob_check_interactions`; do not use ad hoc third-party callback services.
