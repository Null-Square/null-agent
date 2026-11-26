# Header Injection Mutation Algebra

| Parser boundary | Candidate/control |
|---|---|
| raw value | inert marker without separators |
| encoding | one percent-encoded CR/LF form accepted by the application |
| normalization | proxy raw capture versus application-decoded value |
| sink | redirect, filename, or custom response header |
| proof | second inert `X-B1` field in raw HTTP |

Do not inject cookies, cache policy, security-header changes, bodies, or cross-user content. Stop after four encodings or one structural raw-header differential.
