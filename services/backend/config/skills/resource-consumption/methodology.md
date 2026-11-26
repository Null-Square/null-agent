# Resource Consumption Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Use only for a specific in-scope operation with a stable low-cost baseline and an authorized isolated or low-impact environment. Candidate surfaces include pagination, export, regex/search, decompression, image/PDF processing, GraphQL complexity, webhook retries, and unbounded collection inputs.

Define the resource hypothesis before testing: CPU time, wall time, memory, response bytes, database rows, queue depth, or downstream calls. Do not treat slow service or a large documented export as a vulnerability without a controllable amplification relationship and missing enforcement.

## Surface Discovery and Prioritization

1. Prefer source/config evidence of missing bounds, then verify one public operation.
2. Record documented limits, server rejection behavior, pagination ceilings, and tenant quotas.
3. Select one test dimension and one observable health signal.
4. Avoid shared production queues and endpoints where a single request can trigger billing, email, fulfillment, or third-party fan-out.

## Safe Test Ladder

1. Send three baseline requests at concurrency 1 and record median latency, response bytes, and health signal.
2. Increase one input dimension to 2x baseline, never beyond the documented normal maximum.
3. Send one matched control with equivalent request size but without the expensive semantic structure.
4. Repeat at most twice only if health stays within the stop envelope.
5. Confirm enforcement by testing one value just above the documented limit when that request is safe and should be rejected.

Hard caps: concurrency 1; no more than six candidate requests per endpoint; five-second client timeout; stop if candidate latency exceeds two seconds above baseline, health latency rises by 20%, an error-rate change occurs, memory/queue alarms move, or a request remains running.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Cardinality: page size, list elements, GraphQL nodes, or batch items.
- Shape: flat versus nested input at the same serialized byte size.
- Computation: literal versus regex/wildcard/search expression.
- Compression: declared size versus bounded expansion in a local fixture only.
- Fan-out: one recipient/destination versus the smallest multi-target control, never real external recipients.
- State: fresh versus cached operation to avoid confusing warm-up effects.

## Proof Standard

Proof requires a bounded, reproducible amplification curve or a demonstrated missing server limit with health remaining inside the stop envelope. One timeout, a scanner DoS label, a slow shared environment, or a source loop alone is a lead. Never require degradation or outage as proof.

## False Positives and Benign Lookalikes

1. Cold starts, cache misses, autoscaling, or deployment activity affect candidate and control.
2. The requested response is large because the user explicitly requested a documented export.
3. Client timeouts occur while the server cancels work and enforces its own safe deadline.
4. Rate limits, quotas, pagination caps, or complexity budgets reject the candidate.
5. Test instrumentation or a proxy buffers the response and creates apparent latency.

## Missing Prerequisites and Blocked Behavior

Block when health telemetry is unavailable, the environment is shared, the operation has irreversible fan-out, or baseline variance exceeds 20%. Preserve the smallest safe input, declared cap, and telemetry needed to resume.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_differential` for bounded paired timings, application metrics already exposed to the test tenant, and `python_session` for offline curve calculation. Use repository reads for limit/config evidence. General scanners and high-concurrency fuzzers are not allowed for proof.

## Handoffs and Duplicate Prevention

Hand endpoint inventory to `api-enumeration`, GraphQL cost structure to `graphql`, and race-specific invariants to `race-conditions`. `validation` owns the final finding decision. Do not duplicate a timeout reported by infrastructure monitoring without input-attributed amplification.

## Stop, Cleanup, and Data Minimization

Cancel any outstanding test job, delete generated test exports, and record whether server-side cancellation completed. Retain only aggregate timings, sizes, cap responses, and sanitized telemetry. Stop at the first threshold crossing even if proof is incomplete.

## Sources

- [OWASP API Security Top 10 2023 - Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [CWE-400: Uncontrolled Resource Consumption](https://cwe.mitre.org/data/definitions/400.html)
