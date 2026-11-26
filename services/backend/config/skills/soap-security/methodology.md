# SOAP Security Methodology

Use this method for SOAP action routing, WS-Security identity/signature coverage, operation authorization, schema handling, and evaluator-owned message replay. XML external entities belong to `xxe`.

## Preconditions and Fast Applicability

Require a confirmed SOAP endpoint, observed valid envelope or WSDL, evaluator credentials/certificates, safe read/reversible operation, and message-size cap. Default: sixteen envelopes, 64 KiB, no unknown mutations.

## Surface Discovery and Prioritization

Map SOAP version, WSDL operations, action headers, endpoint addresses, security headers/tokens, signature references, timestamps, body/header roles, faults, and gateway/application routing.

## Safe Test Ladder

1. Replay a valid evaluator envelope.
2. Remove/alter authentication header.
3. Mismatch HTTP action and body operation.
4. Compare owner, peer evaluator, and nonexistent object.
5. Alter one signed evaluator field while preserving the rest.
6. Replay once inside/outside timestamp policy.
7. Test one documented optional header with role/must-understand control.
8. Verify final state and cleanup.

## Variation Matrix

| Axis | Variants |
|---|---|
| version | observed SOAP 1.1/1.2 only |
| routing | matching/mismatched action and body |
| security | valid, absent, altered evaluator token/signature |
| identity/object | owner, peer evaluator, nonexistent |
| freshness | current, replayed/expired test message |
| header | one documented role/must-understand variant |

## Proof Standard

Proof requires an unauthorized operation/data result, accepted integrity/freshness violation, or action/body routing to a protected operation, with valid and negative controls plus authoritative state. WSDL exposure, SOAP faults, or signature-library errors are leads only.

## False Positives and Benign Lookalikes

- gateways can authorize before the service;
- HTTP action can be ignored safely when body routing is authorized;
- faults may use HTTP `200`;
- signatures can cover a referenced body despite element reordering;
- timestamps can allow documented clock skew;
- WSDL may intentionally be public.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without a valid envelope/WSDL, evaluator security material, safe operation, or signature-reference visibility. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` preserving XML bytes, offline schema/signature inspection, and evaluator certificates only. Do not generate unknown state-changing operations.

## Handoffs and Duplicate Prevention

Hand XXE to `xxe`, XML data injection to `secondary-server-injections`, object/function authorization to generic owners, and TLS to `tooling-tls`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced control failure, sixteen envelopes, or parser instability. Delete evaluator objects and redact security tokens.

Never perform destructive actions or use another party’s SOAP credentials/data.

Research date: 2026-07-23

## Sources

- W3C SOAP 1.2 Messaging Framework: https://www.w3.org/TR/soap12/
- OWASP Web Service Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Web_Service_Security_Cheat_Sheet.html
