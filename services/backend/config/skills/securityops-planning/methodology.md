# SecurityOps Planning — Methodology

This file is the deeper reference for the planner. It encodes the pentester
methodology the planner is expected to apply when SKILL.md's high-level rules
are not enough to choose between options.

The planner is allowed to read this file mid-planning when:

- The run goal is ambiguous and the planner needs a phase decision tree.
- A class is in scope and the planner needs the class's evidence floor.
- A revalidation or chain hypothesis needs the standard pattern.

## 1. Phase Decision Tree

Use the first matching branch.

1. **No assets or services in `query_inventory` for the verified target.**
   - Phase: Recon.
   - Plan one `broad-surface-scan` mission per primary host. Add a
     mapping mission (`api-enumeration`, `js-surface-analysis`) only if the
     host is known web-tech.

2. **Inventory shows assets but no `scan.coverage(family="broad-surface")` or coverage is stale.**
   - Phase: Recon → Mapping.
   - Plan broad-surface on uncovered assets. Then one mapping mission on the
     primary asset to confirm endpoints and tech.

3. **Fresh broad-surface coverage exists; no candidate findings; goal is
   discovery.**
   - Phase: Mapping → Vulnerability Analysis.
   - Plan endpoint enumeration via `api-enumeration` and one or two class
     missions matched to discovered tech (see §3 routing matrix).

4. **Open candidate Risks exist (state=potential or not_reproduced, summary
   present) and goal includes "validate" / "confirm" / "reproduce".**
   - Phase: Validation.
   - One mission per candidate, each with `revalidates_finding_id` set,
     `expected_artifact` describing the durable proof shape required for
     `promote_finding`.

5. **Validated findings exist and the goal asks for downstream impact.**
   - Phase: Validation, then Reporting.
   - Form a chain hypothesis and plan the smallest next step that demonstrates
     consequence. Execute it when every link stays on authorized targets and
     inside bounded PoC. Stop before credential/secret retrieval, real-user
     impact, persistence, disruption, destruction, bulk extraction, or an
     internal/third-party namespace pivot.

6. **Operator goal is explicit closeout / reporting.**
   - Phase: Reporting.
   - One `security-reporting` mission. Include a clear instruction to
     call `report_finalizer_preflight`, call `prepare_report_context`, write `run.digest`, author
     `summary.md` / `report.md`, and then call `finalize_run_artifacts`.

7. **None of the above match.**
   - Default to Mapping → one Vulnerability Analysis mission on the highest
     value surface, with an explicit replan checkpoint as the last mission.

## 2. Coverage Frameworks

The planner does not need to enumerate every framework ID. It does need to
recognize when one applies and route to the right class skill.

### Web (OWASP WSTG)

- `WSTG-INFO-*` Information gathering → `broad-surface-scan`,
  `js-surface-analysis`, `spa-recon`, `information-disclosure`.
- `WSTG-IDNT-*`, `WSTG-ATHN-*`, `WSTG-ATHZ-*` Identity, authentication,
  authorization → `broken-auth`, `idor`, `jwt-attacks`.
- `WSTG-SESS-*` Session management → `broken-auth`, `csrf`.
- `WSTG-INPV-*` Input validation → `sql-injection`, `xss`, `ssrf`,
  `path-traversal`, `xxe`, `nosql-injection`, `open-redirect`.
- `WSTG-ERRH-*` Error handling → `information-disclosure`.
- `WSTG-CRYP-*` Cryptography → `jwt-attacks` for JWT-shaped issues, plus
  manual review.
- `WSTG-BUSL-*` Business logic → `business-logic`, `race-conditions`,
  `mass-assignment`.
- `WSTG-CLNT-*` Client-side → `dom-xss`, `prototype-pollution`.
- `WSTG-APIT-*` API testing → `api-enumeration`, `idor`,
  `mass-assignment`, `graphql`.
- `WSTG-CONF-*` Configuration → `information-disclosure`,
  `subdomain-takeover`, `insecure-file-uploads`.

### API (OWASP API Top 10 2023)

- `API1` BOLA → `idor`.
- `API2` Broken auth → `broken-auth`, `jwt-attacks`.
- `API3` Broken object property level authorization → `mass-assignment`,
  `idor`.
- `API4` Unrestricted resource consumption → `race-conditions`,
  `business-logic`.
- `API5` BFLA → `idor`, `broken-auth`.
- `API6` Unrestricted access to sensitive business flows →
  `business-logic`.
- `API7` SSRF → `ssrf`.
- `API8` Security misconfiguration → `information-disclosure`,
  `subdomain-takeover`.
- `API9` Improper inventory management → `api-enumeration`,
  `subdomain-takeover`.
- `API10` Unsafe consumption of APIs → `ssrf`, `mass-assignment`.

### Bounded-PoC downstream-impact boundary

Multi-link reasoning is part of normal pentesting. Execute safe links that use
synthetic/evaluator-owned state and remain within the authorized namespace.
Credential or secret access, lateral movement, bulk collection/exfiltration,
persistence, material real-user impact, disruption, and cross-namespace
expansion remain outside normal authority. Preserve those next steps as
explicit unexecuted hypotheses for the separately governed full-impact path.

## 3. Skill Routing Matrix

Given the highest-value tech in inventory, the table below names the
**first-choice** class skill the planner should reach for. Pick at most two
class skills per mission.

| Observed tech / shape | First skill | Second skill | Why |
| --- | --- | --- | --- |
| WordPress / PHP CMS | `information-disclosure` | `broken-auth` | Plugin enumeration + admin path discovery |
| Laravel / Rails / .NET | `sql-injection` | `idor` | Common ORM-level injection + IDOR |
| Express / Node BFF | `mass-assignment` | `prototype-pollution` | JS-stack-specific |
| GraphQL endpoint | `graphql` | `idor` | Introspection + alias-based dedup bypass |
| OpenAPI / Swagger | `api-enumeration` | `idor` | Spec-driven enumeration to BOLA |
| OAuth / OIDC visible | `broken-auth` | `jwt-attacks` | Auth flow + token bag |
| AWS / GCP / Azure public metadata proxy surface | `ssrf` | `cloud-aws`, `cloud-azure`, or `cloud-gcp` | Prove only the public application's bounded server-side fetch behavior; never request credentials |
| Next.js / React SPA | `spa-recon` | `dom-xss` | Hidden routes + DOM sinks |
| File upload feature | `insecure-file-uploads` | `path-traversal` | Upload + retrieval bugs |
| Search / filter / lookup endpoint | `sql-injection` | `nosql-injection` | Where injections normally live |
| URL fetch / webhook / preview | `ssrf` | `open-redirect` | URL-fetcher abuse |
| User-controlled HTML rendering | `xss` | `dom-xss` | Reflected vs DOM split |
| Object-id-bearing routes | `idor` | `mass-assignment` | API1 + API3 |
| Login / reset / MFA flows | `broken-auth` | `csrf` | Auth state machine + CSRF on auth |
| Multi-step checkout / payment | `business-logic` | `race-conditions` | Workflow + concurrency abuse |

Routing rule: do not assign a skill solely because the tech_trigger matches.
The asset must also have a confirmed surface that exercises the class. A
WordPress fingerprint without a discovered admin path does not justify a
`broken-auth` mission yet.

## 4. Chain Hypothesis And Boundary Templates

When a bounded finding suggests greater impact, create the next mission only
when its executed effect remains inside PoC. Every chain record includes:

- the validated finding ID and exact evidence already obtained;
- the safe prerequisite and whether it is available, provisionable, blocked,
  or prohibited;
- the downstream security question and smallest proof step;
- the negative control, quantitative cap, and cleanup; and
- the exact boundary that would require full-impact authorization.

Examples of executable safe chains include synthetic BOLA setup and comparison,
inert upload then retrieval, and evaluator-session stored-XSS proof. OAuth token
theft, credential retrieval, real-user privilege use, and code execution after
a file-read primitive remain hypotheses unless a harmless canary proves the
class without crossing the stopping boundary.

## 5. Evidence Floors Per Class

Use these to set `required_evidence` and `expected_artifact`. The executor
will be held to these by the class skill itself, but the planner setting
them up correctly avoids missions that succeed at the action and fail at the
report.

| Class | Minimum durable evidence |
| --- | --- |
| SQL / NoSQL / command / SSTI injection | One HTTP exchange showing the injection extracts data the app would not otherwise return (DB version, file content, arithmetic discriminator), captured request and response |
| Reflected / stored / DOM XSS | Browser-context script execution proof: screenshot or DOM snapshot showing the payload firing in victim context |
| Authentication / session | Two HTTP exchanges in one mission: one valid baseline, one manipulated, showing the auth decision flip |
| BOLA / IDOR | Two-account exchange: account A retrieving B's resource with a B-specific discriminator in the response (username, tenant tag, owner-only field) |
| BFLA | Lower-role account performing an admin-only action with a captured response showing the action took effect |
| SSRF | Outbound connection captured on a controlled OOB listener with full headers proving origin, OR direct response from a restricted target |
| Open redirect | Captured 30x response showing attacker-controlled `Location` |
| CSRF | Cross-origin POST with attacker-controlled body and a captured response showing the action took effect |
| Path traversal | File content disclosed that should not be reachable, or write-path evidence with file modification confirmation |
| XXE | Captured response containing entity-resolved content from outside the document |
| JWT attacks | Forged token accepted: paired exchanges showing original-token denial vs forged-token acceptance |
| Mass assignment | Request setting an unintended field accepted; response or follow-up GET showing the field stuck |
| Prototype pollution | Polluted property reaching a sink with observable side effect |
| Insecure file upload | Uploaded file retrievable AND executes in the destination context (or its content is interpreted as code by the server) |
| Race conditions | Repeated burst captured in `http_list`, with response evidence of the race-only outcome |
| Business logic | Narrative + sequence of HTTP exchanges showing the invariant broken (e.g. negative balance, skipped approval, double-redemption) |
| Information disclosure | Captured response containing sensitive data plus a baseline showing the data is not normally returned |
| Subdomain takeover | DNS record pointing to provider X plus provider X claim attempt with takeover-specific control evidence |

## 6. When To Stop

Each mission must terminate cleanly. Common stop conditions by class:

- Recon / mapping: "no new endpoints in last 2 iterations" or "stop after
  enumerating Swagger / OpenAPI completely".
- Class probe: "after 3 distinct hypotheses with zero response differential
  on the same parameter, OR one validated finding".
- Validation: "one durable evidence pair captured, OR three failed
  reproduction attempts".
- Chain/boundary: "the smallest safe next link is proved with its control and
  cleanup, OR the next required effect is recorded as blocked/prohibited and is
  not executed".
- Closeout: "report_finalizer_preflight called, prepare_report_context called, run.digest written, authored summary.md/report.md written, and finalize_run_artifacts called".

Every normal plan should end with a closeout mission assigned to
`security-reporting`. That mission is where the executor reads the reporting
methodology, calls report_finalizer_preflight and prepare_report_context, writes report.section notes for
evidence-backed durable narrative when useful, writes run.digest, authors
summary.md/report.md, and calls finalize_run_artifacts.
The submit_plan gate rejects normal plans that omit this final authored
mission. Do not rely on the harness to add a generic closeout task; write a
question, required evidence list, and stop condition grounded in the actual
scope and planned evidence.

If the planner cannot name a stop condition, the mission is not ready to
ship. Drop it or sharpen the question.

## 7. Common Failure Modes The Planner Must Avoid

- **Scanner worship.** Planning multiple scanner missions in a row hoping
  one will produce a finding. Scanners are recon. Findings come from
  hypothesis-driven mission probes against confirmed surfaces.
- **Payload spray without app understanding.** Planning class missions
  without a mapping mission first when no endpoint catalogue exists.
- **Missing business logic.** Logic flaws are undetectable by signatures.
  When the app has multi-step workflows, plan a `business-logic` mission;
  do not assume injection coverage finds them.
- **Checkbox completion.** Running every WSTG class against every endpoint.
  Pick one or two highest-impact classes per surface based on the
  inventory.
- **Report dilution.** Planning to ship un-promoted candidates as
  reportables. Planner must include validation missions that produce
  durable evidence before the closeout mission.
- **Scope creep.** Planning missions whose `why_ready_now` references an
  asset that is not in the verified scope.

## B1 Planning Quality Contract

The following sections govern the mission graph emitted from the routing and coverage material above.

### Preconditions and Fast Applicability

Planning requires an operator goal, current scope record, inventory and coverage results, existing findings and notes, available skills, and phase/tool policy. When a source is unavailable, state the assumption and add a query or blocker mission rather than inventing target facts.

### Surface Discovery and Prioritization

Use observed hosts, routes, technologies, identities, and candidate evidence. Prioritize a mission when it is ready now and likely to close a material coverage gap. Version strings and framework names select methodology only; they never justify a finding mission.

### Safe Test Ladder

Build the shortest dependency graph that reaches a decision: scope confirmation, necessary mapping, a class-specific hypothesis, independent validation when warranted, a safe consequence-increasing pivot when supported, then reporting. No executed mission may depend on an effect outside the bounded-PoC boundary.

### Variation Matrix

Vary plans by operator intent, fresh versus return scope, open candidate count, missing prerequisites, and available identities or source context. Do not create speculative branches for every platform family; select only evidence-backed owners.

### Proof Standard

Every validation mission names its owning skill, target, hypothesis, baseline/control, evidence floor, quantitative cap, stop rule, expected artifact, and blocker behavior. A generic “scan for vulnerabilities” objective is not ready.

### False Positives and Benign Lookalikes

Reject plans driven only by stale inventory, duplicate candidate rows, a technology fingerprint, a scanner label, or an already-closed coverage item. Do not confuse a possible downstream handoff with authorization to execute it.

### Missing Prerequisites and Blocked Behavior

Represent a human-controlled prerequisite explicitly with its owner and the safe action it enables. The executor may pursue another in-scope mission, but it may not weaken the proof floor. Never convert blocked or ambiguous work into a finding.

### Tool Selection and Fallback

Assign only tools allowed by the selected skill, phase, and current policy. Prefer a methodology-preserving fallback. Missing tools become blockers; the plan does not request installation or broader permission in B1.

### Handoffs and Duplicate Prevention

Use one primary skill per proof primitive and link safe chain steps through explicit prerequisites and evidence. Related evidence is linked to one canonical finding unless the second primitive is independently reportable. Do not duplicate a primitive merely because it appears in a chain.

### Stop, Cleanup, and Data Minimization

End the plan with reporting and cleanup expectations. Never perform destructive actions or plan persistence, privilege expansion, secret collection, internal pivoting, or work against an unlisted target. Retain only the evidence needed by the selected missions.

Research date: 2026-07-23

## Sources

- Locked B1 authoring and evaluation PRD: ../../../../../docs/prd/3.0/agent-skill-authoring-and-evaluation.md
- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/latest/
- OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
