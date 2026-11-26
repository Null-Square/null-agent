# HTTP Parameter and Method Confusion Methodology

Use this method to test duplicate-parameter precedence, scalar/array/object coercion, method override, and gateway/application method disagreement with evaluator-owned, reversible operations.

## Preconditions and Fast Applicability

Require a valid baseline, known parameter semantics, observed parser/gateway layers, and safe evaluator state. Default cap is twelve requests and one reversible state change.

## Surface Discovery and Prioritization

Map parameter locations, duplicate handling, framework parser types, content-type decoders, method-override support, gateway method rules, and application route methods. Prioritize authorization or validation decisions made before a different downstream interpretation.

## Safe Test Ladder

1. Capture baseline and nonexistent-value control.
2. Duplicate one parameter with identical values.
3. Use conflicting values in both orders.
4. Test scalar versus one-element array/object only when parser accepts it.
5. Compare query/body precedence.
6. Test one documented/observed method override.
7. Verify authoritative evaluator state and repeat once.

Do not use malformed framing; request-smuggling owns message-boundary disagreement.

## Variation Matrix

| Axis | Variants |
|---|---|
| duplicate | same, A/B, B/A |
| location | query, body, one header when observed |
| type | scalar, one-element array, object |
| content type | documented decoders |
| method | baseline, observed override |
| layer | gateway decision, application decision |

## Proof Standard

Proof requires two components to make security-relevant decisions from different interpretations, producing unauthorized evaluator data/action or bypassing a concrete validation rule. Duplicate acceptance, differing error text, or undocumented method support without impact is not proof.

## False Positives and Benign Lookalikes

- frameworks may document first/last value semantics;
- arrays can be valid API inputs;
- proxies may normalize before both decisions;
- method override can be restricted and intentional;
- body/query values can populate different fields;
- a rejected request can still appear in gateway logs.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without a known security decision, parser-layer visibility, safe state, or authoritative outcome. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use raw `http_payload` requests preserving duplicates/order and byte captures. Browser form serialization is a control, not the mutation tool.

## Handoffs and Duplicate Prevention

Hand request boundaries to `http-request-smuggling`, whole-function auth to `access-control`, object auth to `idor`, and business workflow effects to `business-logic`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced interpretation gap, twelve requests, or state uncertainty. Restore evaluator data and keep minimal raw requests.

Never perform destructive actions or ambiguous multi-variable mutations.

Research date: 2026-07-23

## Sources

- OWASP WSTG, HTTP Parameter Pollution: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/04-Testing_for_HTTP_Parameter_Pollution
- OWASP WSTG, HTTP Verb Tampering: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/03-Testing_for_HTTP_Verb_Tampering
