---
slug: tooling-subfinder
name: Subfinder Operation
description: Run subfinder for passive DNS discovery with canonical ingestion.
phase: recon
compatible_phases:
  - recon
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
use_when: Scope contains a root domain with wildcard or subdomain coverage permitted, AND passive discovery sources are allowed by RoE. Use early in fresh-scope recon to expand the asset graph before port discovery and HTTP fingerprinting.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Root domain
  - Optional API keys for premium passive sources
expected_outputs:
  - Subdomain artifact ingested with ingest_scan_artifact(parser="subfinder")
  - Discovered subdomains added to inventory with root-domain context
evidence_floor: Keep the subfinder artifact, passive source context when available, and ingested asset notes. Newly found hosts require httpx or DNS follow-up before endpoint testing.
follow_up_triggers:
  - Hand discovered hosts to dnsx or naabu for resolution and port discovery
  - Hand resolved hosts to httpx for tech fingerprinting
  - Pair with subdomain-takeover when dangling CNAMEs appear
strong_terms:
  - tooling-subfinder
  - subfinder
  - subdomain enumeration
  - passive dns
  - subdomain discovery
tech_triggers:
  - dns
  - http
  - https
ntype_triggers:
  - asset.domain
  - asset.discovered
technique_ids:
  - B1:tooling-subfinder
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
# Subfinder Operation

Use passive discovery first and keep root-domain context attached.
