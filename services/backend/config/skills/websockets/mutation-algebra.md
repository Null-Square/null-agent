# WebSocket Mutation Algebra

- Handshake identity: none, evaluator A, evaluator B.
- Origin: canonical application, owner-controlled unrelated origin.
- Channel/object: owned canary, peer synthetic, nonexistent.
- Message: documented subscribe/read, then one harmless evaluator action.
- Sequence: subscribe-before-auth versus normal order if protocol permits.
- Transport state: fresh connection only; no reconnect storm.

Maximum two concurrent connections, ten messages, and thirty seconds of observation. Never fuzz frames, flood streams, or join non-evaluator channels.
