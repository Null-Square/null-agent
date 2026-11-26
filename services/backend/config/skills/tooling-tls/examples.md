# TLS Tooling Examples

## Useful Measurements

- Enumerate protocol negotiation for the exact in-scope hostname with SNI and record certificate chain and expiry.
- Compare the canonical hostname with one supplied alternate endpoint to identify configuration drift.
- Verify whether a deprecated protocol is actually negotiated, not merely listed by a static config file.

## Non-Findings and Limits

- Certificate transparency history does not prove a host is active or in scope.
- A self-signed certificate on a documented disposable environment is expected.
- Cipher names from a scanner are not impact by themselves.
- Do not run exhaustive handshakes, renegotiation stress, downgrade interception, or client-certificate guessing.

Record resolver result, SNI, port, time, negotiated protocol/cipher, chain hash, and tool version. Route HTTP security policy separately.
