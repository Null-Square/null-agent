---
slug: xxe
name: XXE Testing
description: "XML External Entity injection — local file disclosure, OOB data exfiltration via DNS/HTTP, SSRF via entity resolution, DTD parameter entity chaining. Use when: Java/.NET/PHP stack, XML-consuming APIs, SAML/SOAP endpoints, or file upload features that process document formats."
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
use_when: Use when XML, SOAP, SAML, SVG, DOCX/OOXML, parser errors, upload processors, or XML-like content types are accepted by the target.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - XML parser entrypoints and payload classes tested with safety constraints
  - Local file, SSRF/OOB, entity expansion, or rejection evidence
  - Blocked prerequisite notes for parser access, auth, or OOB limitations
evidence_floor: XXE confirmation requires observable file disclosure, OOB callback, SSRF behavior, or parser-side entity expansion impact. XML parsing alone is not sufficient.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - xxe
  - xml external entity
  - doctype
  - entity expansion
  - xml parser
tech_triggers:
  - java
  - php
  - .net
ntype_triggers:
  - http.endpoint
  - tech.fingerprint:product=xml
technique_ids:
  - B1:xxe
  - PS-XXE
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
# XXE Testing

## Attack Surface
Find XML parsers in APIs, file uploads, office/doc converters, and identity workflows.

## Discovery Methodology
1. Detect XML parser behavior with harmless entities.
2. Test external entity resolution controls.
3. Use OOB resolution only when safe and authorized.

## Mutation Algebra
- DTD inline vs external references
- Parameter entities and nested entities
- Protocol pivots (`file://`, `http://`, `ftp://`)
- Encoding variants (UTF-8/UTF-16 and BOM)

## Validation
Confirm when entity expansion yields local file disclosure, OOB callbacks, or parser abuse impact.
