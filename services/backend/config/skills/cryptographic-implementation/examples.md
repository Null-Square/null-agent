# Cryptographic Implementation Examples

## Strong Evidence

- Source uses a constant IV for AES-GCM and two supplied test ciphertexts repeat the nonce under the same key identifier. Report the nonce-reuse condition; do not attempt key recovery.
- Password hashes in a sanitized fixture use unsalted SHA-1 while current configuration confirms that encoder is active.
- A signed evaluator artifact is accepted after one canonical field changes because verification covers a different serialization than the application consumes.

## Weak Evidence

- A certificate is self-signed in a disposable local environment.
- A base64 value is described as “encrypted.”
- An old algorithm appears only in a disabled migration module.

Key material, production ciphertext, or broad cracking is outside scope. If algorithm, key/nonce provenance, and active call path cannot be tied together, retain a source lead.
