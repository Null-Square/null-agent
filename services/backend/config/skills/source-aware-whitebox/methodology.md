# Source-Aware White-Box Methodology

Use this skill to connect routes, identities, parsers, data flows, authorization decisions, and sinks in source to a minimum runtime validation. Code appearance alone does not create a finding.

## Preconditions and Fast Applicability

Require an authorized repository/revision, deployed-build relationship, source-mode scope, and a runtime target or test harness. Default cap is three source candidates per mission and one dynamic replay per candidate.

## Surface Discovery and Prioritization

Map entry route/handler, middleware/interceptors, authentication principal, authorization checks, validation/decoding, data access, dangerous sink, error path, and relevant configuration/dependency versions. Record file/line plus revision.

## Safe Test Ladder

1. Start from an observed route/operation or a precise static finding.
2. Trace one complete input-to-effect path.
3. Identify sanitizers, guards, feature flags, and unreachable branches.
4. Build a minimum evaluator-owned runtime request.
5. Run baseline, candidate, and negative control through the deployed/test path.
6. Reconcile runtime evidence with exact source lines.
7. Record unreachable/mitigated candidates as rejected.

## Variation Matrix

| Axis | Variants |
|---|---|
| evidence source | observed route, static rule, code review |
| revision | exact deployed/test commit |
| mode | black-box corroboration, greybox logs, white-box harness |
| path | normal, candidate, one guard/control |
| result | reachable proof, mitigated, unreachable, blocked |

## Proof Standard

Proof requires a reachable source path at the tested revision plus runtime behavior meeting the class owner’s proof floor, or a source-only control defect so structurally complete that execution is unnecessary and policy permits source proof. A dangerous API call, scanner match, secret-like string, TODO, or dependency advisory alone is a lead.

## False Positives and Benign Lookalikes

- code may not be deployed;
- framework guards may execute outside the traced file;
- static rules miss sanitization wrappers;
- dead/test code may be scanned;
- feature flags can remove reachability;
- runtime logs can come from another revision.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without revision/deployment mapping, runtime/harness, required identity/data, or safe replay. State the missing link in the trace. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use repository/file reads, `tooling-semgrep` for candidate generation, browser/HTTP for runtime proof, and logs only as corroboration. Preserve revision and rule versions.

## Handoffs and Duplicate Prevention

The class-specific skill owns payloads, proof, severity, and remediation. This skill owns reachability and source correlation. Link one canonical finding.

## Stop, Cleanup, and Data Minimization

Stop after three traced candidates, one proof per root cause, or deployment uncertainty. Remove evaluator fixtures and retain minimal code excerpts/hashes.

Never perform destructive actions, report code appearance as exploitation, or retain repository secrets.

Research date: 2026-07-23

## Sources

- OWASP Code Review Guide: https://owasp.org/www-project-code-review-guide/
- NIST SP 800-218 SSDF: https://csrc.nist.gov/pubs/sp/800/218/final
