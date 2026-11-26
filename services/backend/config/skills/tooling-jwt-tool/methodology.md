# JWT Tooling Methodology

Use JWT tooling only for offline structure/claim/header inspection, token hashing, owner-supplied signature verification, and controlled evaluator-token mutation. The `jwt-attacks` skill owns consumer validation.

## Preconditions and Fast Applicability

Require an evaluator token, intended issuer/audience/type, local/offline tool, redaction policy, and owner-supplied verification key/JWKS when verification is requested. Never paste tokens into web services.

## Surface Discovery and Prioritization

Record token format, encoded segment hashes, header fields, registered/custom claim names, time claims, issuer/audience/type, key identifier/URL references, and verification inputs. Do not log full signatures or secret claims.

## Safe Test Ladder

1. Hash and decode offline without treating decode as validation.
2. Validate JSON/base64url structure and time values.
3. Verify with owner-supplied key and expected algorithm.
4. Compare issuer/audience/type expectations.
5. Create one evaluator-only mutation for consumer replay by `jwt-attacks`.
6. Delete raw token files.

## Variation Matrix

| Axis | Variants |
|---|---|
| operation | decode, verify, hash, controlled mutate |
| key source | owner file, exact trusted JWKS |
| expectation | algorithm, issuer, audience, type, time |
| artifact | original evaluator token, one changed copy |

## Proof Standard

Tool output proves only parse/verification result against explicit inputs. Decoding, weak-looking claims, missing optional fields, or verification failure cannot establish consumer vulnerability.

## False Positives and Benign Lookalikes

- decode is not signature verification;
- clock skew affects time checks;
- audiences can be arrays;
- key rotation makes cached JWKS stale;
- encrypted/opaque tokens are not JWTs;
- client-side token use differs from resource consumer.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without evaluator token, expected claims, trusted verification key, or offline tool. Never guess signing secrets. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Prefer owned `jwt_tool` with offline/no-network options or a local standard-library parser. Redact/hide command arguments where process listings could expose tokens.

## Handoffs and Duplicate Prevention

`jwt-attacks` owns runtime acceptance; OAuth/OIDC owns issuance/transaction context. This tool owns offline artifact provenance.

## Stop, Cleanup, and Data Minimization

Stop after required parse/verify/mutation, then delete raw tokens and retain salted hashes/redacted claims.

Never perform destructive actions, online key attacks, or third-party token upload.

Research date: 2026-07-23

## Sources

- RFC 7519, JSON Web Token: https://www.rfc-editor.org/rfc/rfc7519
- RFC 8725, JWT Best Current Practices: https://www.rfc-editor.org/rfc/rfc8725
