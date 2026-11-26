# Unsafe API Consumption Methodology

Use this method to test how an application validates data, redirects, size, timeout, and trust from an integrated upstream API. The upstream is an owner-provided evaluator stub, never a compromised third party.

## Preconditions and Fast Applicability

Require a confirmed outbound integration, evaluator-controlled stub/fixture, expected schema, and a reversible downstream action. Default cap is ten stub responses, 256 KiB per response, two-second delay, and one redirect to another evaluator endpoint.

## Surface Discovery and Prioritization

Map outbound destination allowlists, TLS/auth, redirects, timeouts, response size, schema validation, content type, parser, downstream storage/rendering, retries, and error handling.

## Safe Test Ladder

1. Return a valid baseline from the evaluator stub.
2. Omit one required field.
3. Change one field type or boundary value.
4. Return one inert marker in a downstream-rendered field.
5. Return an evaluator redirect and verify destination policy.
6. Delay within the two-second cap.
7. Return a response just below/above the documented size limit.
8. Verify downstream state and cleanup.

## Variation Matrix

| Axis | Variants |
|---|---|
| schema | valid, missing field, wrong type |
| transport | valid TLS endpoint, evaluator redirect |
| timing | baseline, bounded delay |
| size | around documented cap |
| downstream | storage, rendering, decision canary |

## Proof Standard

Proof requires evaluator-controlled upstream data or redirect to cause an unsafe downstream action, unauthorized data exposure, or bypass of a concrete validation/allowlist/limit, with baseline and controls. Integration presence, generic failure, or source appearance is not proof.

## False Positives and Benign Lookalikes

- retries can duplicate stub requests without duplicate effects;
- schema evolution can make optional fields intentional;
- gateways can follow redirects while stripping sensitive data safely;
- timeout fallbacks can be expected;
- a value may be escaped downstream;
- test stubs can differ from production transport.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without an evaluator stub, exact integration path, expected schema, or safe downstream observation. Never target a real provider. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use the owner-provided mock/stub, request logs, `http_payload` for inbound triggers, and source/config reads. Do not intercept or modify third-party traffic.

## Handoffs and Duplicate Prevention

Hand downstream injection/XSS/SSRF to its class owner and webhook inbound trust to `webhook-security`. This skill owns the trust boundary from upstream response to application.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced trust failure, ten responses, or retry instability. Remove stub data and evaluator objects.

Never perform destructive actions, service disruption, or data transfer to non-evaluator endpoints.

Research date: 2026-07-23

## Sources

- OWASP API10:2023 Unsafe Consumption of APIs: https://owasp.org/API-Security/editions/2023/en/0xaa-unsafe-consumption-of-apis/
