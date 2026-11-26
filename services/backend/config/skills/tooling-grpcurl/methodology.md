# grpcurl Tooling Methodology

Use grpcurl to list/describe authorized gRPC schemas and invoke explicit safe methods with supplied descriptors and evaluator metadata. It does not brute-force services or create findings.

## Preconditions and Fast Applicability

Require exact endpoint/authority, TLS mode, reflection permission or proto/protoset, explicit method, JSON request, evaluator metadata, deadline, and output path. Default cap is twenty calls and 64 KiB messages.

## Surface Discovery and Prioritization

Prefer supplied descriptors. Query reflection once only when policy permits. Record service/method type, request/response descriptors, metadata names, authority, TLS verification, and streaming mode.

## Safe Test Ladder

1. Verify channel/TLS and list from supplied descriptors.
2. Describe the explicit service/method.
3. Invoke one known-good unary evaluator request.
4. Invoke methodology candidate and control.
5. For an observed stream, send at most two messages and close.
6. Save JSON, gRPC status/trailers, timing, and command with redacted metadata.

## Variation Matrix

| Axis | Variants |
|---|---|
| schema | proto/protoset, permitted reflection |
| RPC | unary, one observed stream |
| metadata | valid, omitted/invalid per owning test |
| TLS | verified endpoint, owner-supplied client cert |
| output | JSON/text with status/trailers |

## Proof Standard

Tool evidence requires exact command/config, descriptor hash, request JSON, response, gRPC status/trailers, and time. Method existence or reflection output is inventory only.

## False Positives and Benign Lookalikes

- HTTP `200` can carry non-OK gRPC status;
- authority/SNI mismatch reaches wrong service;
- stale descriptors cause decode errors;
- reflection can be proxy-filtered;
- metadata values can expire;
- stream cancellation can look like server failure.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without descriptors/reflection authority, explicit safe method, evaluator metadata, or TLS trust material. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `-proto`/`-protoset`, exact `-d` JSON file, deadline, TLS verification, and redacted headers. Do not use plaintext unless the authorized endpoint is explicitly plaintext.

## Handoffs and Duplicate Prevention

`grpc-security` owns method/control interpretation. grpcurl owns invocation provenance.

## Stop, Cleanup, and Data Minimization

Stop at result/control, twenty calls, or stream uncertainty. Remove request files containing secrets and close channels.

Never perform destructive actions or invoke unknown state-changing RPCs.

Research date: 2026-07-23

## Sources

- grpcurl Repository: https://github.com/fullstorydev/grpcurl
- gRPC Reflection: https://grpc.io/docs/guides/reflection/
