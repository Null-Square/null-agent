---
slug: tooling-trufflehog
name: TruffleHog Operation
description: Run verified secret scanning with JSON output and redaction hygiene.
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
freshScopePriority: medium
use_when: A repository, filesystem, or archive is connected to the run AND secret exposure is in scope per RoE. Use for verified-only secret detection on source workspaces, git history, S3 buckets, or unpacked artifacts. Prefer trufflehog when verification (live secret check) is needed; prefer gitleaks when broader regex coverage is needed without verification.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Repository, filesystem path, or archive
  - Optional verification toggle (--only-verified)
expected_outputs:
  - JSON artifact ingested with ingest_scan_artifact(parser="trufflehog")
  - Verified secret findings with redacted previews
evidence_floor: Keep verified-result JSON with redacted secret values, source path, detector type, and verification status. Full secret material must not be copied into prompts or reports.
follow_up_triggers:
  - Pair verified secrets with information-disclosure or broken-auth class skills
  - Promote only after the secret is confirmed live and the affected scope is named
  - Record scan.coverage(family="trufflehog") for the workspace path scanned
strong_terms:
  - tooling-trufflehog
  - trufflehog
  - secret scanning
  - verified secret
  - credential leak
tech_triggers:
  - git
  - github
  - gitlab
  - bitbucket
  - s3
  - docker
  - npm
  - pypi
ntype_triggers:
  - asset.source
  - asset.repository
  - finding.candidate
technique_ids:
  - B1:tooling-trufflehog
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
# TruffleHog Operation

Prefer verified-only results for candidate findings.
