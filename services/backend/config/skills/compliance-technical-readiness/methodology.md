<!-- B1-NORMALIZED-START -->
# Compliance Technical Readiness Control Checks — B1 Methodology Contract

Research date: 2026-07-23

## Preconditions and Fast Applicability

Confirm the target, identity, environment, route, and action are in the current RoE. Apply this package when the observed surface can exercise the named behavior: Dedicated technical-readiness skill for agent-provable compliance controls outside the access-control family, including transport, inventory, vulnerability, monitoring, SDLC, and supply-chain evidence.

Stop as not applicable when the required protocol, sink, state transition, identity boundary, or source artifact is absent. A fingerprint or version string establishes inventory only.

## Surface Discovery and Prioritization

1. Start from durable inventory and a clean baseline request, artifact, or browser flow.
2. Prioritize reachable, user-controlled boundaries with meaningful data, action, identity, or control impact.
3. Record the identity, state, parser, transport, encoding, cache, timing, and platform dimensions that apply.
4. Deduplicate against related skills and existing evidence before sending probes.

## Safe Test Ladder

1. Capture an unchanged baseline and a negative control.
2. Change one bounded variable and compare normalized behavior.
3. Repeat the signal with a second controlled variation or identity.
4. Escalate only to the minimum non-destructive proof allowed by policy.
5. Stop immediately at reproducible proof, a policy boundary, quantitative cap, or environmental blocker.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation. Resource, race, cache, and parser tests must remain within declared request and concurrency caps.

## Variation Matrix

- Identity: anonymous, owner, peer, tenant peer, and privileged control when authorized.
- State: fresh, replayed, expired, revoked, concurrent, and reordered where applicable.
- Parser and encoding: canonical form first, then one bounded alternate parser, duplicate, normalization, or encoding case at a time.
- Transport and platform: method, content type, HTTP version, browser channel, framework, operating system, or managed-platform difference only when observed.
- Cache and timing: compare controls; do not create broad persistence or availability impact.

Read `mutation-algebra.md` when this package declares systematic mutation applicability.

## Proof Standard

Treat scanner hits, errors, reflection, headers, fingerprints, version matches, source appearance, and timing outliers as leads. A finding needs a reproducible unauthorized application action, data disclosure, state change, control bypass, or deterministic safe execution result, plus durable request/response, browser, command, or source evidence and the matching negative control.

## False Positives and Benign Lookalikes

1. A version, banner, route, header, or technology fingerprint without the vulnerable behavior.
2. A parser error, timeout, generic 2xx/5xx response, or scanner match that does not reproduce impact.
3. Intended public, same-owner, same-tenant, cached-control, mock, or client-only behavior mistaken for an authorization or server-side boundary failure.
4. A source pattern that is unreachable, sanitized, protected by a missing precondition, or contradicted by runtime evidence.

## Missing Prerequisites and Blocked Behavior

Record an explicit blocker when a second identity, required state, protocol support, repository context, safe callback, or authorized environment is unavailable. Preserve what was attempted and what evidence would unblock the check. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Prefer agent-native HTTP, browser, replay, repository-read, and file tools. Use an installed CLI only through its owned tooling or methodology package, with machine-readable output and bounded rates. If the preferred tool is unavailable, use a declared alternative that stays inside the same phase and worker policy; otherwise block.

## Handoffs and Duplicate Prevention

Keep platform and framework packages focused on specialization, generic vulnerability packages focused on the proof primitive, and `validation` responsible for the final proof decision. Reuse existing baselines and evidence references. Do not repeat a completed variation without a new hypothesis.

## Stop, Cleanup, and Data Minimization

Stop at proof, falsification, a two-attempt guard, a quantitative cap, or a blocker. Remove temporary state and callbacks, close special connections, redact secrets and personal data, retain only the minimum proof, and document cleanup.

## Sources

- [Locked B1 authoring and evaluation PRD](../../../../../docs/prd/3.0/agent-skill-authoring-and-evaluation.md)
- [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/latest/)
- [Technology or protocol reference](https://owasp.org/www-project-web-security-testing-guide/latest/)
<!-- B1-NORMALIZED-END -->
