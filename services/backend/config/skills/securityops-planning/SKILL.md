---
slug: securityops-planning
name: SecurityOps Planning
description: Planner-only methodology for converting prior coverage, current inventory, open findings, tried approaches, and known blockers into an evidence-driven PTES/WSTG/API mission graph that performs comprehensive discovery, bounded proof, and safe same-scope chain validation without crossing the authorized impact boundary.
phase: planning
compatible_phases:
  - planning
category: planning
required_tools:
  - query_inventory
  - list_relevant_skills
  - submit_plan
tool_alternatives: []
risk_tier: low
freshScopePriority: low
use_when: Always during SecurityOps planning before submit_plan. This is the only skill the planner runs. It produces the mission graph the executor and worker prompts read from.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - query_inventory output for the current scope
  - query_findings output (full, including canonical state, summary, cweIds)
  - query_notes(ntype="run.digest") for prior-run intent and agent-actionable next assessment recommendation
  - query_notes(ntype="approach.tried") for techniques already attempted
  - query_notes(ntype="approach.blocker") for prerequisites that stalled work
  - query_notes(ntype="scan.coverage") for which assets have fresh broad sweep
expected_outputs:
  - 3 to 5 mission nodes that advance from prior evidence
  - Each mission carries question, why_ready_now, required_evidence, expected_artifact, stop_condition, assigned_skills, optional parallel_safe_with, and optional revalidates_finding_id
  - Final mission is a security-reporting closeout that runs report_finalizer_preflight, prepares report context, writes authored summary.md/report.md, writes run.digest, and calls finalize_run_artifacts
  - At least one validation, evidence, or promotion-ready mission whenever findings or candidate findings already exist for the scope
  - A markdown plan whose H1 names the operation and target precisely
evidence_floor: 'Every mission must point to a concrete observed fact: a named asset, a known finding ID, an exact technique+endpoint that was tried with a specific outcome, a missing scan.coverage record, or a recorded blocker. Generic phrasing like "continue testing", "explore further", or "improve coverage" is rejected.'
follow_up_triggers:
  - A new asset appeared in inventory and has needsBroadScan=true
  - A finding has assertions but no durable evidence and is candidate-stage
  - A blocker note matches a current asset and the prerequisite is now satisfied
  - A prior run.digest agent-actionable recommendation is unmet and still applicable
strong_terms:
  - securityops-planning
  - planning
  - mission graph
  - assigned skills
  - phase plan
  - scope strategy
  - securityops
tech_triggers: []
ntype_triggers: []
technique_ids:
  - B1:securityops-planning
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills: []
handoff_skills:
  - broad-surface-scan
mutation_applicability: not_applicable
mutation_not_applicable_reason: This package is an orchestration, reporting, compliance, validation, or tool-operation contract; systematic exploit-input mutation is owned by the invoking methodology.
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - playbooks.md
fixture_manifest: fixtures/manifest.yaml
---
# SecurityOps Planning

The planner determines the success of the run. The model sees the plan every
turn through the APPROVED PLAN section. If the plan is wrong about *what to
test* or *why now*, the executor will spend its budget on the wrong things and
the run will not produce evidence that promotes to reportable.

The planner runs only this skill. Read it fully every plan.

## 1. Always Read Prior State First

Before writing any mission, call all of:

```
query_inventory({ assetKind: "all", includeServices: true, includeEndpoints: true })
query_findings({ status: "all", severity: "all" })
query_notes({ ntype: "run.digest", limit: 10 })
query_notes({ ntype: "approach.tried", limit: 25 })
query_notes({ ntype: "approach.blocker", limit: 10 })
query_notes({ ntype: "scan.coverage", limit: 25 })
```

These are gated by `submit_plan`. The plan is rejected without them.

## 2. Build A Do-Not-Repeat Ledger

From the queries above, write down (mentally, then in `why_ready_now` text)
the do-not-repeat ledger:

- **Validated findings already known.** A new mission about the same target
  and class must declare `revalidates_finding_id` and explain what changes
  this run.
- **Technique + endpoint pairs already tried.** If a `(technique, endpoint)`
  pair has an outcome of `failed` or `blocked`, do not plan it again unless
  you can name a specific new hypothesis (different payload class, different
  auth context, different role, different parameter encoding, etc.).
- **Assets with fresh broad coverage.** If `scan.coverage(family="broad-surface", status="completed")` exists for an asset
  and `lastScannedAt` is fresh, do not plan another broad scan for that asset.
- **Human-controlled blockers.** If a blocker note names a prerequisite (test
  account, scope expansion, RoE clarification) and that prerequisite is still
  unmet, do not plan the blocked work. Plan around it with another
  agent-actionable in-scope path first. When no productive assessment path
  remains, plan a blocked closeout that records the unmet prerequisite in
  `next_prerequisites`.

## 3. PTES Spine (Phase Selection)

Map the run goal to its phase. Missions belong to one phase each. Most runs
should advance one phase, not skip phases.

| Phase | Mission shape | Skill bundle |
| --- | --- | --- |
| Pre-engagement / Recon | Inventory expansion, asset confirmation, broad sweep on new hosts | `broad-surface-scan`, `network-recon`, `subdomain-takeover`, `js-surface-analysis`, `spa-recon`, `tooling-subfinder`, `tooling-naabu`, `tooling-httpx`, `tooling-katana`, `tooling-nmap` |
| Mapping | Endpoint enumeration, auth-flow capture, parameter discovery, role/tenant matrix | `api-enumeration`, `js-surface-analysis`, `spa-recon`, `graphql`, `nextjs`, `tooling-ffuf`, `tooling-katana` |
| Vulnerability Analysis | Hypothesis-class probes per surface (one class per mission) | `idor`, `sql-injection`, `xss`, `dom-xss`, `ssrf`, `xxe`, `path-traversal`, `open-redirect`, `csrf`, `mass-assignment`, `prototype-pollution`, `nosql-injection`, `jwt-attacks`, `broken-auth`, `business-logic`, `race-conditions`, `information-disclosure`, `insecure-file-uploads`, `tooling-nuclei`, `tooling-sqlmap`, `tooling-dalfox`, `tooling-ffuf` |
| Code / Secret / Dependency Scan | Source-aware SAST, secret leakage, container/dependency CVE review on connected workspaces or unpacked archives | `tooling-semgrep`, `tooling-trivy`, `tooling-gitleaks`, `tooling-trufflehog` |
| Blind / OOB Validation | Out-of-band callback proof for blind classes (no in-band response) | `tooling-interactsh` paired with `ssrf`, `xxe`, `rce` |
| Exploitation / Validation | Reproduce a candidate with class-specific evidence floor; produce evidence sufficient for `promote_finding` | The class skill the candidate belongs to, plus `validation` when the mission carries `revalidates_finding_id` |
| Reporting / Closeout | Final narrative, run.digest with a specific agent-actionable next assessment recommendation when one exists | `security-reporting` |

Anti-patterns:

- Skipping mapping when no endpoint catalogue exists for the scope.
- Planning vuln-analysis missions on assets without confirmed services.
- Planning closeout when active candidates have not been validated.

## 4. Risk Prioritization

Within the chosen phase, order missions by expected impact, not by alphabet.
For web/API scopes the standard priority order is:

1. **Authentication and authorization issues first.** BOLA / IDOR / BFLA /
   broken-auth dominate real impact and are hardest for scanners to find.
2. **Server-side injections that reach data or commands.** SQLi, command,
   SSTI, NoSQLi, SSRF.
3. **Server-side data exposure.** Information disclosure, mass assignment,
   path traversal, XXE.
4. **Client-side and session issues that compose with #1–#3.** XSS,
   open-redirect, CSRF, JWT, prototype pollution.
5. **Business logic.** Workflow flaws, race conditions, payment/discount
   abuse. Plan these once the surface is well-mapped.

When the run goal is a specific class (`xss`, `idor`, `auth bypass`, etc.),
that class becomes the spine and the order is mapping → bounded class probes →
class-specific validation → the next safe impact-increasing pivot when one is
supported → reporting. A second link is expected when it remains inside the
authorized namespace and bounded-PoC stopping contract.

## 5. Mission Shape Rules

Every mission is a hypothesis with a stop condition, not a tool invocation.

- `question` — the security question, phrased so a yes/no answer is possible.
  Good: *"Can a non-admin user retrieve admin-only resources via numeric ID
  enumeration on /api/users/{id}?"* Bad: *"Test for IDOR."*
- `why_ready_now` — cite a concrete fact: an inventory entry, a finding ID,
  a tried-and-blocked note that has a new hypothesis, a new asset since last
  run, a new credential set, an unmet prior-run recommendation.
- `required_evidence` — list the minimum evidence that answers the question.
  For class missions this comes from the class skill's `evidence_floor`.
- `expected_artifact` — what the executor must produce. Concrete: *"BOLA
  candidate finding with two-account discriminator HTTP exchange and a CWE
  mapping."* Not: *"findings."*
- `stop_condition` — when the mission stops cleanly even if no finding lands.
  Concrete: *"Three blocked attempts on this endpoint, OR one validated
  finding, OR scope of object IDs exhausted (50+ tested)."*
- `assigned_skills` — assign every methodology the mission genuinely needs.
  A single surface usually crosses techniques (a login form is auth + session
  + csrf + an injection class; an API object is idor + access-control + mass-
  assignment), so a mission that names three, four, or five class skills is
  correct when each earns its place against the mission's evidence floor. The
  worker can load them. Do not pad with unrelated skills "just in case," and
  do not starve a genuinely multi-technique surface down to one probe — thin
  single-skill missions are what made runs shallow. Class and `tooling-*`
  skills only. Every normal run has a final closeout mission assigned only to
  `security-reporting`; do not add `security-reporting` to earlier testing
  missions.
- `parallel_safe_with` — list mission IDs whose evidence does not overlap
  with this one. Two recon missions on different subdomains are safe; two
  injection missions on the same endpoint are not.
- `revalidates_finding_id` — set when the mission retests a known finding.
  The executor will pass this to `report_finding(..., validatesFindingId)`
  so fresh evidence attaches to the existing finding instead of creating a
  duplicate row.

When a mission's question is best answered by a scanner, pair the vuln-class
skill with one `tooling-*` skill in `assigned_skills`. Example: a
mass-assignment validation mission may pair `mass-assignment` +
`tooling-nuclei`; a blind SSRF probe may pair `ssrf` + `tooling-interactsh`;
a recon-confirmation mission may pair `broad-surface-scan` +
`tooling-subfinder` + `tooling-httpx`. Pair as many `tooling-*` skills as the
class skills' evidence floors call for — the tooling skill is the operational
driver for a class skill's evidence floor, not an extra "in case we need it"
bundle.

## 6. Bounded-PoC Chain Reasoning

Chain depth and impact are different. The planner must connect primitives
when another safe step can demonstrate consequence, satisfy a prerequisite,
or reject a high-value hypothesis. It must not stop merely because the next
question creates a second link.

For every strong primitive:

1. name the concrete downstream security hypothesis;
2. identify the smallest next step and its prerequisite;
3. execute that step when it stays on an authorized target, uses synthetic or
   evaluator-owned state, is reversible, and needs no sensitive-data or
   credential retrieval;
4. require a baseline or negative control plus durable proof;
5. clean up evaluator-created state; and
6. stop and preserve the unexecuted hypothesis when the next step would affect
   a real user, retrieve secrets or bulk data, establish persistence, cause
   disruption/destruction, cross a tenant beyond minimal proof, or expand to
   another namespace/provider.

Allowed examples include a two-synthetic-account IDOR sequence, an inert
upload followed by authorized retrieval, a stored-XSS canary viewed in an
evaluator session, and a public-signup prerequisite followed by role/object
comparison. SSRF to cloud credentials, OAuth token theft, real-user privilege
use, web/reverse shells, and internal or third-party pivots remain hypotheses
or separately authorized full-impact work.

## 7. Validation And Promotion Awareness

`report_finding` is record-only. Only `promote_finding` makes a finding
reportable, and it requires durable evidence (HTTP exchange or a non-missing
artifact) that satisfies the class's evidence floor. The planner is
responsible for making sure the executor has a path to durable evidence on
every finding the run is meant to ship.

Concrete rules:

- If the run goal includes shipping reportables, plan at least one mission
  that ends in evidence sufficient for `promote_finding`.
- If a candidate finding already exists in the scope, plan a **validation
  mission** that names the candidate by ID via `revalidates_finding_id` and
  describes the missing evidence shape.
- If the executor will need a controlled OOB listener (SSRF), a second user
  account (IDOR), or a specific role (BFLA), include the prerequisite in
  `required_evidence` and `why_ready_now` so the executor sets up the
  evidence apparatus before probing.

Validation missions targeting an existing finding should set
`assigned_skills=['validation', <relevant class skill>]`. The `validation`
skill drives fresh-context reproduction discipline (no parent-evidence
trust, durable command-backed evidence, explicit
`submit_validation_outcome`); the class skill provides the
technique-specific methodology and evidence floor. The same pairing is
inherited by validator workers spawned automatically from
`promote_finding`.

## 8. Run Type Templates

Pick the template that matches the goal. See `playbooks.md` for full
expansions.

- **Fresh-scope discovery** — broad-surface-scan on the verified target,
  mapping/enumeration on confirmed services, one follow-up vuln-analysis or
  explicit replan checkpoint, then a `security-reporting` closeout mission.
- **Return-scope continuation** — read prior digest, plan from the open
  finding queue or the unmet recommendation, do not re-broad-scan.
- **Targeted validation** — one to two missions per candidate finding,
  carry `revalidates_finding_id`, end with promotion-readiness.
- **Targeted class validation** — assume mapped surface; use the relevant
  class skill on the named in-scope target, validate minimum proof, and run the
  next safe impact-increasing pivot when it remains inside bounded PoC. Preserve
  any step beyond that boundary as an unexecuted hypothesis.
- **Closeout-only** — single `security-reporting` mission to assemble
  outstanding findings, when the operator asked for a report cycle.

## 9. Hard Anti-Patterns

The plan is rejected at submit time if:

- Mission count > 5 for a scope that already has fresh broad coverage and no
  open candidate findings.
- A mission's `assigned_skills` is empty or contains skills not in the run's
  `skillSlugs`.
- A non-recon goal produces a recon-only plan with no follow-up validation
  or replan checkpoint.
- A retried `(technique, endpoint)` pair is referenced in any mission
  without an entry in `retriedApproaches` carrying a `new_hypothesis`.

The plan should be rewritten by the planner if any of these are true even
when not auto-rejected:

- Two missions in the same plan duplicate the same security question.
- A mission relies on evidence that the executor would have to gather as a
  side effect of another mission (sequence them with `why_ready_now`
  pointing at the dependency).
- The plan does not describe a clear path to at least one promote-eligible
  artifact when the goal is "find vulnerabilities" or "validate findings".

## 10. Output Discipline

- H1 names the operation and target precisely. *"Authorization Boundary
  Validation for api.acme.com"* — not *"Assessment Plan"*.
- Mission count: **3 to 5** for typical runs. Smaller is better. The plan
  should fit on one screen of the operator's review UI.
- Mission IDs are `task-1`, `task-2`, ... in order. Use them consistently
  with `parallel_safe_with` and prerequisite references.
- The mission JSON block emitted as `submit_plan.missions` must be the same
  ordered set as the markdown task list. The runtime parses the JSON; the
  markdown is for the operator review.

If `playbooks.md` matches the current run shape, follow it as a structural
template, then specialize per the live evidence. If `methodology.md` covers
a class skill the run will exercise, read it for the specific evidence floor
the executor will need to produce.
