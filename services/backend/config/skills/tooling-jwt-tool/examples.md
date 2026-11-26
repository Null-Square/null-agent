# JWT Tooling Examples

## Safe Offline Work

- Decode a redacted evaluator token locally to inventory `iss`, `aud`, `alg`, `kid`, and time claims.
- Verify an evaluator token against supplied JWKS and record the selected key identifier.
- Construct a synthetic token only for a disposable local verifier fixture that demonstrates an algorithm/claim-validation regression.

## Not Allowed

- Brute-forcing signing secrets.
- Using a discovered private key or production secret.
- Replaying an evaluator token against unrelated services.

Decoded claims are not trusted until verification and application consumption are shown. Redact the signature and sensitive claims in retained artifacts; hand protocol context to `jwt-attacks` or `oauth-oidc`.
