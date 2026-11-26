---
slug: path-traversal
name: Path Traversal Testing
description: "Path traversal and LFI testing — relative/absolute path escapes, double-encoding, null-byte tricks, OS-specific separator variants, Zip Slip in archive extractors. Use when: PHP/Apache/nginx/Node.js detected, file download/template/include parameters visible, or archive extraction features present."
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
use_when: Use when file, path, template, download, import, export, image, document, archive, or include parameters can influence filesystem or object-storage paths.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Candidate path parameters and normalization behavior with tested payloads
  - Confirmed or rejected read/write traversal, LFI, archive traversal, or object-key escape
  - Evidence refs showing safe, non-destructive proof and blocked prerequisites
evidence_floor: Path traversal requires proof that attacker-controlled path input accesses data or behavior outside the intended boundary. Generic 404/500 responses are only leads.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - path-traversal
  - path traversal
  - directory traversal
  - ../
  - file read
  - lfi
  - download endpoint
  - path
  - traversal
tech_triggers:
  - php
  - apache
  - nginx
  - node.js
ntype_triggers:
  - http.parameters
  - http.endpoint
technique_ids:
  - B1:path-traversal
  - PS-TRAVERSAL
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
# Path Traversal Testing

## Attack Surface
Locate parameters controlling filenames, directories, templates, backup paths, or export destinations.

## Discovery Methodology
1. Probe relative path handling and canonicalization.
2. Test traversal in query, body, headers, and encoded forms.
3. Check both read and write primitives.

## Mutation Algebra
- Separator variants (`../`, `..\\`, mixed separators)
- Encoding variants (`%2e%2e%2f`, double-encoding)
- Prefix/suffix bypasses (`....//`, null-byte style legacy patterns)
- Absolute path pivots and drive prefixes

## Validation
Confirm with reproducible unauthorized file read/write outside intended directory boundaries.
