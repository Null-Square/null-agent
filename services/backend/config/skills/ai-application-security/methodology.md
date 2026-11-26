# AI Application Security Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Apply to an in-scope application where model output can influence tools, retrieval, identity, data access, workflow state, or externally visible content. Define the application boundary, model role, trusted instructions, available tools, retrieval sources, acting identity, and the concrete unauthorized outcome before testing.

Strange text, policy disagreement, hallucination, prompt leakage without a secret, or a model saying it would act are not findings. The issue must produce a reproducible application action, data disclosure, identity/control bypass, or corrupted trusted decision.

## Surface Discovery and Prioritization

1. Map instruction sources: system policy, developer configuration, user input, retrieved documents, tool output, memory, and cross-session artifacts.
2. List every model-reachable tool with actual authorization checks and side effects.
3. Trace retrieval ACLs and whether source labels/provenance survive into the prompt.
4. Identify deterministic checkpoints where the application validates tool arguments, output schemas, user confirmation, and tenant identity.
5. Prioritize indirect prompt injection in attacker-controlled content that reaches a privileged workflow.

## Safe Test Ladder

1. Establish a clean task with no adversarial content and retain tool/decision traces.
2. Add a unique inert instruction marker in one untrusted source; observe whether the model cites or repeats it.
3. Ask the marker to request a harmless test-only action, such as selecting a canary record or calling a no-side-effect test tool.
4. Pair with a source marked untrusted or inaccessible to the acting persona.
5. Confirm the application—not model prose—performed or disclosed the unauthorized canary outcome.

Use test tenants, synthetic documents, no-side-effect tools, and unique canaries. At most three attempts per injection source. Do not request secrets, real messages, purchases, destructive writes, credential use, or downstream exploitation.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Instruction source: direct user, retrieved page/document, tool result, memory, or imported conversation.
- Trust label: trusted, untrusted, inaccessible, or missing provenance.
- Identity: same user, peer user, tenant peer, and privileged test control.
- Tool class: read-only canary, reversible test write, approval-gated action, or forbidden action.
- Output channel: prose, structured JSON, tool call, stored workflow state, or retrieved answer.
- Session state: fresh context, follow-up, summarized memory, and cross-session retrieval.

## Proof Standard

Proof requires an objective unauthorized application effect tied to the adversarial source: a tool call the acting user could not authorize, disclosure of a synthetic cross-boundary canary, persisted trusted-state corruption, or bypass of an enforced approval/control. Model text alone remains a lead. Retain prompt-source provenance, trace/tool arguments, authorization context, result, and a clean control.

## False Positives and Benign Lookalikes

1. The model repeats an injected string but no tool or application state changes.
2. The acting user already has permission to read the returned synthetic record.
3. A mock tool call appears in prose and is never executed by the application.
4. Retrieval returns public content intentionally shared with all tenants.
5. A stochastic answer differs but no security invariant or objective output contract is violated.
6. Safety filters block the request before any application effect.

## Missing Prerequisites and Blocked Behavior

Block when tool traces are unavailable, a second identity or synthetic cross-tenant document cannot be created, the only test would touch real data, or the application has no objective action/data boundary. Preserve the injection source and required canary/control design.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser/HTTP capture for the application flow, query tools for canonical traces and synthetic records, and repository reads for trust/authorization placement. Do not judge model quality from screenshots alone. Use a fixed model/configuration for regression and record model identifier, prompt-source hashes, and run trace.

## Handoffs and Duplicate Prevention

Hand ordinary IDOR or access-control failures to their owners when the model is incidental. Hand unsafe tool argument execution to the concrete sink skill, retrieval ACL failures to `access-control`, and final evidence disposition to `validation`. This package owns failures caused by AI instruction/data/tool trust composition.

## Stop, Cleanup, and Data Minimization

Remove injected synthetic documents, reset test memory, and reverse canary state. Stop at the first objective boundary violation or after three controlled attempts. Retain only synthetic canaries, source hashes, trace/tool records, and authorization context.

## Sources

- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
- [OWASP Agentic AI Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/)
