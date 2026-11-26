# grpcurl Tooling Examples

## Valid Commands in Context

- List services only when reflection is authorized: `grpcurl -plaintext target.test:443 list`.
- Invoke a supplied unary descriptor with one synthetic message and explicit evaluator metadata.
- Repeat the same message without authorization metadata as a control.

## Invalid Methodology

- Enumerating unknown production services without reflection approval.
- Opening long-lived streams or sending high message counts.
- Treating `UNKNOWN` or `UNIMPLEMENTED` as vulnerability proof.

Record target, TLS mode, descriptor source, metadata names with values redacted, request hash, status code, and response canary. Prefer captured protobuf fixtures over ad hoc payload construction.
