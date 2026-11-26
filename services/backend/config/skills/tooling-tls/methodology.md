# TLS Tooling Methodology

Use TLS tooling to capture certificate chains, name/time validation, protocol/cipher negotiation, ALPN, OCSP/stapling signals, and service-specific STARTTLS on exact authorized endpoints. It is transport evidence, not automatic vulnerability proof.

## Preconditions and Fast Applicability

Require exact hostname/IP/port, SNI name, expected service, authorization, trust-store context, and connection cap. Default is ten handshakes per endpoint and no exhaustive cipher enumeration.

## Surface Discovery and Prioritization

Record DNS/address, SNI, negotiated protocol/cipher/group/signature, ALPN, leaf/chain subjects and SANs, validity, trust result, stapled status when present, session resumption/early data only when relevant, and proxy/CDN context.

## Safe Test Ladder

1. Perform verified default handshake with correct SNI/hostname.
2. Capture full chain and validation result.
3. Test explicitly old protocols only when policy requires confirmation.
4. Compare one hostname/SNI control.
5. Test one service-specific STARTTLS negotiation if observed.
6. Confirm ALPN for HTTP/2/gRPC when relevant.
7. Repeat decisive result once.

## Variation Matrix

| Axis | Variants |
|---|---|
| endpoint | exact host/IP/port |
| name | correct SNI/hostname, one mismatch control |
| protocol | default, policy-required legacy check |
| service | direct TLS, observed STARTTLS |
| validation | system trust, owner-supplied CA |
| negotiation | ALPN/cipher/group evidence |

## Proof Standard

Tool evidence requires exact endpoint/SNI, command/version, raw verification outcome, negotiated parameters, and timestamp. A certificate/version/cipher list becomes a finding only against an applicable policy and reproducible negotiation or trust failure.

## False Positives and Benign Lookalikes

- missing SNI reaches a default certificate;
- IP scans mismatch names by design;
- CDN edge policy differs from origin;
- local trust stores differ;
- offered ciphers are not necessarily accepted;
- transient OCSP/network failures can affect validation.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without correct SNI, policy/trust context, STARTTLS protocol, or authorized endpoint. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use OpenSSL `s_client`/certificate tools with hostname verification and concise output, plus protocol-native clients for corroboration. Do not disable verification in the final evidence path.

## Handoffs and Duplicate Prevention

Platform/network skills own endpoint inventory; `cryptographic-implementation` owns application crypto. TLS tooling owns transport negotiation evidence.

## Stop, Cleanup, and Data Minimization

Stop at policy decision, ten handshakes, or service instability. Close connections and retain public certificate/negotiation data only.

Never perform destructive actions, renegotiation/load stress, or scanning outside exact endpoints.

Research date: 2026-07-23

## Sources

- OpenSSL `s_client`: https://docs.openssl.org/master/man1/openssl-s_client/
- RFC 8446, TLS 1.3: https://www.rfc-editor.org/rfc/rfc8446
- RFC 9325, TLS/DTLS Recommendations: https://www.rfc-editor.org/rfc/rfc9325
