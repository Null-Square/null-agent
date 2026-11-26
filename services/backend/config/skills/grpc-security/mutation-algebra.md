# gRPC Mutation Algebra

- Descriptor source: supplied proto → authorized reflection.
- Call type: unary only by default; streaming requires an explicit case.
- Metadata: evaluator authorization present → omitted → second evaluator.
- Message identity: owner canary → peer synthetic → nonexistent.
- Transport: native gRPC → gRPC-Web only when both are observed.
- Deadline: three seconds → one documented service-specific limit.

Cap at three messages per method and two concurrent channels. Status text or reflection alone is not proof.
