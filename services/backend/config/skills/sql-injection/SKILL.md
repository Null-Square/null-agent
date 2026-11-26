---
slug: sql-injection
name: SQL Injection Testing
description: "SQL injection testing — parameter enumeration, error-type classification, boolean/time-based blind SQLi, union-based extraction, mutation algebra for WAF bypass. Use when: MySQL/PostgreSQL/MSSQL/SQLite detected, http.parameters notes exist, or login/search/filter/lookup endpoints with user input are in scope."
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - report_note
  - report_finding
  - submit_validation_lead_outcome
  - submit_validation_outcome
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: User-controlled query parameters, form fields, or JSON body values reach search, filter, lookup, login, reporting, or object retrieval endpoints, especially when SQL database technology is detected or response behavior suggests query construction.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Baseline request and response for the tested endpoint
  - User-controllable parameter, form field, or JSON value
  - Stable comparison signal such as response body, status, row count, or latency
expected_outputs:
  - Parameter-specific SQL control proof using error, boolean, or time-based evidence
  - Baseline versus mutant request/response comparison
  - Affected endpoint, input name, database family if known, and safe reproduction steps
evidence_floor: Confirm only with durable evidence of database error leakage, a deterministic boolean response delta, or a reproducible time delay tied to the same input.
follow_up_triggers:
  - Database errors or stack traces appear after low-noise probes
  - Boolean variants produce stable response differences
  - Search, filter, login, lookup, or report endpoints accept raw user input
  - Database or framework fingerprints suggest query-backed endpoints
strong_terms:
  - sql-injection
  - sql injection
  - sqli
  - sqlmap
  - union select
  - boolean blind
  - time based
  - sql
  - injection
tech_triggers:
  - mysql
  - postgresql
  - mssql
  - php
  - laravel
  - rails
ntype_triggers:
  - http.parameters
  - tech.fingerprint:product=mysql
  - tech.fingerprint:product=postgresql
technique_ids:
  - B1:sql-injection
  - PS-SQLI
  - WSTG-INPV
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
  - scripts/.gitkeep
fixture_manifest: fixtures/manifest.yaml
---
# SQL Injection Testing

## Attack Surface
Look for numeric and string parameters used in search, filtering, auth, and object lookup.

## Discovery Methodology
1. Start with low-noise probes (`'`, `"`, `)`, `--`, `/*`).
2. Compare baseline vs boolean variants (`and 1=1`, `and 1=2`).
3. Use time-based checks only when response content is stable.

## Mutation Algebra
- Whitespace changes: `%09`, `%0a`, `/**/`
- Keyword splits: `UN/**/ION`, `SEL/**/ECT`
- Comment variants: `--+`, `#`, `/*...*/`
- Encoding pivots: URL encoding, double encoding, case mutation

## Validation
Treat as confirmed when one of: DB error leakage, deterministic boolean delta, or reproducible time delay.
