---
# Portions adapted from Strix (https://github.com/usestrix/strix), Apache-2.0,
# Copyright 2025 OmniSecure Inc.; changed by NullSquare, Inc. See NOTICE.
slug: nextjs
name: Next.js Security Testing
description: "Next.js-specific testing: middleware bypass via path normalization and x-middleware-subrequest header, Server Action IDOR outside UI flow, RSC flight data over-fetching, caching boundary failures (cross-user cached pages), NextAuth callback URL open redirect, image optimizer SSRF, and Edge vs Node runtime divergence. Use when: _next/ paths, __NEXT_DATA__ script tag, or Next-Action header detected."
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
use_when: Use when Next.js headers, routes, build artifacts, _next assets, middleware clues, app/router manifests, image optimizer paths, or Vercel-style deployment behavior appear.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Next.js surface map covering framework version clues, special routes, and exposed assets
  - Test results for middleware bypass, cache issues, image optimizer, and data route exposure
  - Finding leads or coverage notes tied to exact route/request evidence
evidence_floor: Next.js findings require a framework-specific request path or asset proof with observable impact. Merely identifying Next.js is inventory, not a vulnerability.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - nextjs
  - next.js
  - _next
  - server action
  - middleware
  - image optimizer
tech_triggers:
  - next.js
  - nextjs
  - nextauth
  - vercel
ntype_triggers:
  - tech.fingerprint
  - http.endpoint
technique_ids:
  - B1:nextjs
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
# Next.js Security Testing

## Attack Surface
Middleware, App Router route handlers, Server Actions, RSC payloads, Pages Router
API routes, ISR on-demand revalidation endpoints, NextAuth callbacks, and the
`/_next/image` optimizer.

## Discovery Methodology
1. Extract route map from `__BUILD_MANIFEST`, source maps, `__NEXT_DATA__`, and chunk filenames.
2. Test middleware bypass via path normalization variants and crafted internal headers.
3. Invoke Server Actions directly with arbitrary inputs outside the intended UI flow.
4. Probe RSC payloads and ISR responses for cross-user data in cached output.
5. Test `/_next/image?url=` with internal hostnames and redirect chains for SSRF.

## Mutation Algebra
- Path normalization: `/admin` → `/admin/` → `/api//admin` → `/api/./admin`
- Header injection: `x-middleware-subrequest`, `x-nextjs-data`
- Content-type switching on Server Actions (JSON → multipart → urlencoded)
- Strip auth cookie to verify cache boundary isolation per identity

## Validation
Show protected content accessed via middleware bypass, cross-user data returned from
RSC payload or ISR cache without identity key, or Server Action executing privileged
operation without expected server-side authorization check.
