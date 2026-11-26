# gRPC Security Methodology

Use this method to validate gRPC service/method authorization, metadata credentials, reflection exposure, message property controls, streaming isolation, and bounded limits with evaluator identities/data.

## Preconditions and Fast Applicability

Require a confirmed HTTP/2 gRPC endpoint, observed method or supplied `.proto`/descriptor, evaluator credentials/objects, and a safe client. Default cap is twenty unary messages, one two-message stream, and 64 KiB messages.

## Surface Discovery and Prioritization

Record authority, TLS, service/method descriptors, reflection policy, metadata auth, deadlines, unary/stream types, interceptors, field semantics, and status/trailer behavior.

## Safe Test Ladder

1. Replay one valid unary call.
2. Call with missing/invalid evaluator metadata.
3. Compare owner, peer evaluator, and nonexistent object.
4. Change one protected canary field.
5. Query reflection once when policy permits.
6. Reproduce one observed stream with two evaluator messages.
7. Test deadline and message size just around documented bounds.
8. Verify state and close channel.

## Variation Matrix

| Axis | Variants |
|---|---|
| RPC | unary, one observed stream |
| identity | owner, peer evaluator, unauthenticated |
| object | owner, peer evaluator, nonexistent |
| metadata | valid, absent, invalid |
| schema | normal, one canary field |
| limit | around documented deadline/size |

## Proof Standard

Proof requires unauthorized evaluator data/action, misbound stream delivery, or objective failure of a documented method/field/limit control with status, trailers, identity, object controls, and final state. Reflection or descriptor exposure alone follows deployment policy and is not automatically a vulnerability.

## False Positives and Benign Lookalikes

- HTTP status can be `200` while gRPC status is denial;
- gateways can translate auth/status;
- reflection may be intentionally public;
- unknown fields are often ignored by protobuf;
- stream buffering can delay denial;
- retries can duplicate client observations.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without descriptors/observed calls, evaluator identities, safe stream, or status attribution. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `tooling-grpcurl` with exact descriptors/metadata and structured output. Use source reads for interceptors. Do not brute-force service names.

## Handoffs and Duplicate Prevention

Hand object/property/function authorization to their generic owners when transport is incidental, TLS to `tooling-tls`, and resource behavior to `resource-consumption`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced control failure, twenty calls, or stream instability. Close channels and delete evaluator objects.

Never perform destructive actions, unbounded streams, or calls to unknown state-changing methods.

Research date: 2026-07-23

## Sources

- gRPC Authentication Guide: https://grpc.io/docs/guides/auth/
- gRPC Reflection Guide: https://grpc.io/docs/guides/reflection/
- Protocol Buffers Language Guide: https://protobuf.dev/programming-guides/proto3/
