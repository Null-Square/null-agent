# SSRF Mutation Algebra

| Axis | Bounded variation | Invariant |
|---|---|---|
| Token | fresh submitted versus fresh unsubmitted | callback host |
| Path | existing canary versus nonexistent path | public evaluator origin |
| Redirect | direct versus one controlled 302 | final host remains evaluator-owned |
| Encoding | canonical versus one URL-encoded delimiter | decoded public URL |
| Lifecycle | immediate versus correlated async job | job id |
| Attribution | server versus browser/proxy control | token and timestamp |

Private, loopback, link-local, metadata, credential, and file-scheme targets are never mutations.
