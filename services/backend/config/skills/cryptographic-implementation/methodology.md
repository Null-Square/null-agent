# Cryptographic Implementation Methodology

Use this skill for application-level misuse of encryption, signatures, nonces, randomness, key derivation, secret storage, and cryptographic protocol composition. TLS configuration belongs to `tooling-tls`.

## Preconditions and Fast Applicability

Require a concrete cryptographic artifact or source path, intended security property, evaluator-owned plaintext/token, and permitted offline analysis. Default cap is twenty samples and no key guessing.

## Surface Discovery and Prioritization

Map artifact format, algorithm/parameters, key source/rotation, nonce/IV generation, authentication tag/signature, context binding, error behavior, and consumer. Prioritize nonce reuse, unauthenticated encryption, signature exclusion, predictable security tokens, and hardcoded production secrets.

## Safe Test Ladder

1. Generate two baseline artifacts for equal and different evaluator inputs.
2. Compare length, randomness, nonce/IV, and deterministic fields offline.
3. Change one ciphertext/signature/context byte and replay only to the intended evaluator consumer.
4. Test cross-context replay between two evaluator objects.
5. Collect up to twenty nonces/tokens for duplication/structure checks.
6. Corroborate parameters and key handling from source/config.
7. Stop without brute force or secret recovery.

## Variation Matrix

| Axis | Variants |
|---|---|
| input | same evaluator value, different evaluator value |
| artifact | original, one-byte change, truncated |
| context | intended object, second evaluator object |
| lifecycle | current key/version, documented rotated test key |
| evidence | runtime differential, source/config |

## Proof Standard

Proof requires violation of the stated property: accepted modification, cross-context replay, repeated nonce where uniqueness is required, deterministic security token with predictive evidence, or reachable hardcoded secret. Algorithm names, short samples, deprecation lists, or scanner warnings are leads only.

## False Positives and Benign Lookalikes

- deterministic encryption may be intentional for non-sensitive lookup;
- visible nonces need not be secret;
- encoded data can look encrypted;
- duplicated prefixes can be format headers;
- rejection errors can differ before authentication checks;
- test keys may be isolated from production.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without the security property, consumer, sufficient safe samples, or source/key context. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use offline parsers, hashing/statistics, `file_read`, and exact `http_payload` replays. Never upload artifacts to third-party analyzers.

## Handoffs and Duplicate Prevention

Hand JWT validation to `jwt-attacks`, OAuth binding to `oauth-oidc`, password auth policy to `broken-auth`, and transport crypto to `tooling-tls`.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced property failure, twenty samples, or any secret exposure. Delete raw keys/tokens and retain hashes/parameters.

Never perform destructive actions, key guessing, or decrypt unrelated data.

Research date: 2026-07-23

## Sources

- NIST SP 800-57 Part 1 Rev. 5: https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
