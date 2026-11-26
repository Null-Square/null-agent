---
slug: tooling-sqlmap
name: SQLMap Operation
description: Drive sqlmap with bounded risk, non-destructive proof, and stable output artifacts.
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
freshScopePriority: medium
use_when: In-scope HTTP services with user-controlled query/body parameters have been mapped, AND the SQL database technology is fingerprinted, OR a candidate SQLi finding already exists with the parameter and method captured. Use sqlmap as a validator for a narrow hypothesis, not a first-pass scanner across an unmapped surface.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Exact baseline request or URL
  - Parameter under test
  - DBMS hint when known (mysql, postgresql, mssql, oracle, sqlite)
expected_outputs:
  - Bounded sqlmap artifact ingested with ingest_scan_artifact(parser="sqlmap")
  - Reproduction notes for confirmed injection only
evidence_floor: Keep bounded sqlmap output, target request, risk/level settings, and proof artifacts. Use non-destructive checks and require manual impact confirmation before promotion.
follow_up_triggers:
  - Pair confirmed injection with the sql-injection class skill for evidence-floor coverage
  - Capture an http_exchange showing the injection plus a proof-of-data response
  - Promote only after non-destructive proof (boolean/time/UNION) is recorded
strong_terms:
  - tooling-sqlmap
  - sqlmap
  - sqli scanner
  - dbms fingerprint
  - injection test
tech_triggers:
  - mysql
  - postgresql
  - mssql
  - sqlite
  - oracle
  - mariadb
  - php
  - asp
  - aspnet
  - jsp
  - http
  - https
ntype_triggers:
  - http.parameters
  - http.endpoint
  - tech.fingerprint
  - finding.candidate
technique_ids:
  - B1:tooling-sqlmap
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
# SQLMap Operation

Use sqlmap as a validator for a narrowed hypothesis, not a broad first-pass scanner.
