---
slug: tooling-nuclei
name: Nuclei Scanner Operation
description: Drive nuclei safely with JSONL output, scoped templates, and mandatory artifact ingestion.
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
freshScopePriority: high
use_when: "Live HTTP/HTTPS services have been mapped (httpx or katana already ran), AND one of the following is true: the mission asks for template-backed coverage on a tech fingerprint (e.g. wordpress, jenkins, jira, swagger, graphql); a candidate finding needs templated re-confirmation; or a CVE/exposure class template family applies to the discovered stack. Do not run the full template set against an unfingerprinted surface."
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - In-scope URL or URL list (already confirmed live)
  - Rate limit and severity boundary
  - Template tags or template directory scoped to the fingerprint
expected_outputs:
  - JSONL artifact ingested with ingest_scan_artifact(parser="nuclei")
  - Candidate findings or scanner observations with template IDs
evidence_floor: Keep the nuclei JSONL artifact, template IDs, severity, matcher evidence, and command scope. Scanner positives remain candidates until class-specific validation confirms impact.
follow_up_triggers:
  - Validate any medium-or-higher template hit with the matching class skill
  - Promote candidates only after class-specific evidence floor is satisfied
  - Record scan.coverage(family="nuclei") for the asset and template tags used
strong_terms:
  - tooling-nuclei
  - nuclei
  - template scan
  - cve template
  - exposure template
  - scanner
tech_triggers:
  - http
  - https
  - swagger
  - openapi
  - graphql
  - php
  - wordpress
  - jenkins
  - jira
  - tomcat
  - spring
  - apache
  - nginx
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
  - asset.discovered
  - scan.coverage
technique_ids:
  - B1:tooling-nuclei
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
# Nuclei Scanner Operation

Use nuclei for scoped template checks, not blind all-template runs against unknown surfaces.
