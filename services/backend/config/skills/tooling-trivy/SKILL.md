---
slug: tooling-trivy
name: Trivy Operation
description: Run dependency, filesystem, image, and SBOM scanning with JSON output.
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
use_when: Use for source, container image, or filesystem vulnerability review.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Filesystem path, repository path, or image reference
expected_outputs:
  - JSON artifact ingested with ingest_scan_artifact(parser="trivy")
evidence_floor: Keep Trivy JSON output, scan target, package/image identifiers, CVE IDs, and version evidence. Validate exploitability or exposure context before report promotion.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - tooling-trivy
  - trivy
  - container scan
  - dependency cve
  - misconfiguration
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:tooling-trivy
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
# Trivy Operation

Use Trivy for dependency and container vulnerability observations.
