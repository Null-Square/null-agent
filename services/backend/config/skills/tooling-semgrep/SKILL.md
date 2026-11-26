---
slug: tooling-semgrep
name: Semgrep Operation
description: Run Semgrep for source-aware security findings with SARIF output.
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
use_when: A repository or unpacked source workspace is connected to the run, AND the language/framework can be detected (or has been recorded by another scan). Use Semgrep when the planner needs source-backed observations with file and line evidence — not for runtime/HTTP testing.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Repository or workspace path
  - Language or framework context (or "auto")
  - Ruleset selector (e.g. p/owasp-top-ten, p/javascript, p/python)
expected_outputs:
  - SARIF artifact ingested with ingest_scan_artifact(parser="semgrep")
  - Source-anchored candidate findings with file:line evidence
evidence_floor: Keep SARIF/JSON output, rule IDs, file paths, and source snippets with sensitive data redacted. Findings need runtime or code-path validation before reporting.
follow_up_triggers:
  - Validate medium-or-higher SARIF results with manual code review or runtime probe
  - Pair source findings with the matching class skill (e.g. sql-injection, xss, ssrf)
  - Record scan.coverage(family="semgrep") for the workspace path and ruleset
strong_terms:
  - tooling-semgrep
  - semgrep
  - static analysis
  - source scan
  - sast
tech_triggers:
  - javascript
  - typescript
  - python
  - java
  - go
  - ruby
  - php
  - csharp
  - node
  - express
  - django
  - flask
  - spring
  - rails
ntype_triggers:
  - asset.source
  - tech.fingerprint
  - code.location
  - finding.candidate
technique_ids:
  - B1:tooling-semgrep
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
# Semgrep Operation

Use Semgrep to create source-backed observations with file and line evidence.
