# HTTP Request Smuggling Testing

Research date: 2026-07-23

## Preconditions and Fast Applicability

Use this skill only when all of the following are true:

- the target and exact virtual host are authorized;
- an HTTP front end, reverse proxy, gateway, CDN, service mesh, or protocol downgrade is observed or credibly indicated;
- the test client can preserve exact wire bytes and connection reuse behavior; and
- a unique, harmless canary path can be requested without changing application state.

Record ALPN, the client-side protocol, response `Via`/gateway evidence, and whether the same request behaves differently over HTTP/1.1 and HTTP/2. HTTP/2 used end to end has one framing mechanism and is not a classic CL/TE candidate. HTTP/2-to-HTTP/1 downgrading, HTTP/1 connection reuse, or a server that answers before consuming a declared body keeps the skill applicable.

Do not apply this skill to a single confirmed HTTP/2 hop with no downgrade evidence, a client that silently rewrites lengths, or an environment where a dedicated self-owned connection cannot be maintained.

## Quantitative Safety Envelope

Request desynchronization can affect other users. Apply these limits unless the RoE is stricter:

- one endpoint and one virtual host at a time;
- concurrency `1`;
- at most two candidate attempts per framing family and two matching controls;
- at most 12 raw requests total per endpoint during detection;
- five-second response timeout; never extend a pause to match a production server's long timeout;
- only a unique nonexistent canary path such as `/__nullai_desync_<nonce>`;
- only self-owned follow-up requests on the same dedicated TCP/TLS connection;
- no victim simulation, cache poisoning, credential capture, internal routing, browser connection-pool poisoning, pause-based desync, or cross-user response interference.

Stop immediately if a response contains another user's data, an unexpected state change occurs, error rates rise, or connection behavior becomes unstable. Close the connection and record a blocker instead of escalating.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation. Never convert blocked or ambiguous work into a finding.

## Surface Discovery and Prioritization

1. Use TLS/ALPN and ordinary requests to establish supported client protocols.
2. Compare a harmless `GET` and small `POST` over HTTP/1.1 with `Connection: close` and keep-alive.
3. Identify gateway-generated endpoints such as redirects or error pages separately from application endpoints; early responses can indicate CL.0 behavior.
4. Note front-end normalization: duplicate `Content-Length`, simultaneous `Transfer-Encoding` and `Content-Length`, malformed chunking, whitespace before a header value, or forbidden HTTP/2 header characters should normally be rejected.
5. Prioritize only a stable, non-state-changing endpoint. Do not begin on login, checkout, upload, administrative, or expensive routes.

## Wire-Capture Requirements

Use a raw socket-capable client. Disable automatic `Content-Length` correction, redirect following, decompression, and retry. Retain:

- exact request bytes with CRLF boundaries;
- exact response bytes and arrival order;
- connection identifier and whether it was reused;
- negotiated protocol and TLS server name;
- timestamps for connect, first byte, and completion; and
- the control request sent through an independent connection.

Rendered HTTP text is insufficient when the tool may normalize duplicate headers or chunk sizes.

## Safe Test Ladder

### Stage 1: rejection and normalization controls

Send each control on a fresh connection:

1. canonical fixed-length request;
2. canonical chunked request, if HTTP/1.1 chunked requests are accepted;
3. a request containing both `Transfer-Encoding: chunked` and `Content-Length`.

RFC 9112 says a sender must not send both fields and a recipient ought to treat that ambiguity as an error. A clean `400` plus connection close is expected control behavior. Acceptance alone is only a lead.

### Stage 2: bounded timeout differential

Use the smallest framing discrepancy that causes one parser interpretation to await bytes while the other considers the message complete. Run:

- control, candidate, control, candidate;
- on four fresh connections;
- with the same route, body bytes, and five-second client timeout.

A repeatable candidate-only delay is a parser-disagreement signal, not proof. Uniform delay, rate limiting, upstream retries, or random gateway timeouts reject the signal.

### Stage 3: self-contained same-connection canary

Only after a stable Stage 2 signal:

1. create a unique canary path that is known to return a harmless `404`;
2. send the minimum ambiguous request;
3. send one ordinary follow-up request on the same dedicated connection;
4. compare the follow-up response with the same follow-up sent on a clean connection; and
5. close the connection immediately after the pair.

Proof requires the canary prefix or response association to alter only the tester's own follow-up in the predicted way, twice, while the clean pair remains normal. Do not wait for or interact with another user's request.

## Framing Families

### CL.TE

Hypothesis: the front end frames by `Content-Length`; the back end honors chunked `Transfer-Encoding`.

- Keep the declared outer length exact for the bytes the front end receives.
- Terminate the back-end chunked body with `0\r\n\r\n`.
- Place only the unique harmless canary prefix after that terminator.
- A candidate-only timeout can occur when the back end waits for the remainder of a chunk; a same-connection canary differential is required for proof.

### TE.CL

Hypothesis: the front end decodes chunked transfer coding; the back end frames by `Content-Length`.

- Ensure the chunk stream is syntactically complete for the front end.
- Set the inner `Content-Length` so the back end stops before the harmless canary prefix.
- Preserve the final zero chunk and CRLF exactly.
- Never use a state-changing prefix or an administrative path.

### TE.TE

Hypothesis: both hops support transfer coding, but only one recognizes an obfuscated `Transfer-Encoding`.

Begin with the canonical ambiguous control. Test at most two observed, standards-relevant normalization differences, one at a time. Examples are duplicate header fields or whitespace accepted by one known hop. Do not spray an obfuscation corpus. If the infrastructure cannot be identified well enough to justify one variation, block.

### CL.0 and early-response desync

Hypothesis: a server responds without consuming a body declared by `Content-Length`.

- Use a harmless endpoint that returns a server-generated redirect or error.
- Send a small body containing only the unique canary prefix.
- Follow with one self-owned request on the same connection.
- A response arriving before the declared body is sent is a signal; predicted contamination of the self-owned follow-up is proof.

Do not run pause-based variants against production. They intentionally hold partial requests and fall outside the quantitative B1 envelope.

### HTTP/2 downgrade: H2.CL and H2.TE

First prove downgrade relevance by comparing front-end HTTP/2 behavior with back-end/gateway indicators. Then test only pseudo-header or length information that the client library can preserve without prohibited raw newline injection.

- H2.CL: determine whether a supplied length influences the downgraded HTTP/1 message contrary to the HTTP/2 frame length.
- H2.TE: determine whether a forbidden or synthesized transfer-coding field reaches the HTTP/1 back end.

An HTTP/2 protocol error, stream reset, or gateway `400` is expected defensive behavior, not a finding. Raw CRLF injection into downgraded headers is outside B1 unless a dedicated local fixture and explicit security authorization are provided.

## Variation Matrix

After identifying one family, vary only a dimension supported by observed architecture:

- protocol: HTTP/1.1 direct versus HTTP/2 front end with downgrade evidence;
- route owner: gateway-generated response versus application response;
- connection: fresh versus one self-owned reused connection;
- framing: CL.TE, TE.CL, justified TE.TE, CL.0, H2.CL, or H2.TE;
- normalization: one duplicate or whitespace rule at a time;
- body presence: a route documented as bodyless versus one that consumes a small body.

Do not combine framing, header obfuscation, route, and protocol changes in one probe.

## Proof Standard

A reportable finding needs all of:

1. a named parser-disagreement family and observed multi-hop prerequisite;
2. exact raw bytes for candidate and control;
3. two reproductions using unique canaries;
4. a predicted, tester-owned same-connection response differential;
5. a clean independent-connection negative control; and
6. confirmation that no other user's traffic or data was involved.

Timeouts, connection resets, `400` responses, duplicate-header acceptance, scanner output, and HTTP/1 availability are leads only.

## False Positives and Benign Lookalikes

1. A WAF or gateway intentionally delays malformed requests before rejecting and closing them.
2. The client library rewrites `Content-Length`, unfolds headers, or converts HTTP/1 text into HTTP/2 frames.
3. Rate limiting, cold starts, upstream retry, or load-balancer failover creates candidate-independent timing noise.
4. The response sequence is HTTP pipelining behavior with correct request boundaries.
5. A gateway accepts an ambiguous request but removes `Content-Length` before forwarding, as RFC 9112 permits.
6. A unique canary path is routed differently by the application, not parsed as a second request.

## Missing Prerequisites and Blocked Behavior

Block with an explicit reason when exact bytes cannot be preserved, connection reuse is opaque, HTTP/2 downgrade cannot be established, the only available routes change state, or a dedicated connection cannot be isolated. Never convert ambiguous timeouts into a finding.

## Tool Selection and Fallback

Prefer an approved raw HTTP/socket tool that exposes connection reuse and byte counts. Use `openssl s_client` or `socat` only through the owned TLS/tooling path and only for the authorized host. Ordinary `curl` is suitable for baselines but commonly unsuitable for ambiguous framing because it normalizes lengths.

Do not claim support from an automated scanner unless its raw request, exact connection model, controls, and safety limits are retained.

## Handoffs and Duplicate Prevention

- Hand cache-specific effects to `web-cache-security` only after parser disagreement is independently proven.
- Hand response header construction issues to `header-injection`.
- Hand HTTP/2/gRPC application authorization to `grpc-security`; this skill owns framing only.
- Hand final disposition to `validation` with the raw-byte bundle.
- Record the framing family, endpoint, protocol, and normalization axis to prevent another worker from repeating it.

## Stop, Cleanup, and Data Minimization

Close every candidate connection after its self-owned pair. Remove local canary state, retain only the minimum raw bytes and timing table, redact cookies and tokens, and record request counts. Stop after proof, two failed candidate/control pairs for the selected family, any safety signal, or a missing prerequisite.

## Sources

- [RFC 9112: HTTP/1.1 message framing and request-smuggling handling](https://www.rfc-editor.org/rfc/rfc9112.html)
- [PortSwigger Web Security Academy: HTTP request smuggling](https://portswigger.net/web-security/request-smuggling)
- [PortSwigger Web Security Academy: HTTP/2 downgrading](https://portswigger.net/web-security/request-smuggling/advanced/http2-downgrading)
- [PortSwigger research: browser-powered desync attacks](https://portswigger.net/research/browser-powered-desync-attacks)
