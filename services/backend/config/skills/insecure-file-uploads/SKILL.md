---
slug: insecure-file-uploads
name: Insecure File Upload Testing
description: "Test file upload controls for extension bypass, MIME confusion, traversal, and executable payloads. Use when: any endpoint accepts file content or user-supplied filenames."
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
use_when: Use when upload, import, attachment, avatar, document, media, or file-processing endpoints exist and extension, MIME, storage, traversal, or execution controls are unknown.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Upload control matrix covering accepted types, storage path, access URL, and processing behavior
  - Non-destructive bypass or rejection evidence for extension, MIME, traversal, and content checks
  - Blocked prerequisite notes for auth, account role, size limit, or missing upload surface
evidence_floor: A file-upload finding requires proof that unsafe content can be stored, served, processed, overwritten, or executed with meaningful impact. Failed upload attempts should become coverage, not findings.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - insecure-file-uploads
  - file upload
  - multipart
  - upload bypass
  - content-type bypass
  - web shell
  - file extension
  - insecure
  - file
  - uploads
  - upload
tech_triggers:
  - php
  - java
  - node.js
  - nginx
ntype_triggers:
  - http.endpoint
technique_ids:
  - B1:insecure-file-uploads
  - PS-UPLOAD
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
fixture_manifest: fixtures/manifest.yaml
---
# Insecure File Upload Testing

## Attack Surface
Assess whether uploaded files can bypass validation and execute or expose data server-side.

## Discovery Methodology
1. Discover upload endpoints and allowed file types.
2. Attempt extension and content-type bypasses.
3. Test filename traversal and archive extraction abuse.
4. Verify resulting file placement and execution behavior.

## Validation
Confirm only when upload policy bypass is reproducible with clear impact evidence.
