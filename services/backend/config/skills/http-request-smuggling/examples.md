# HTTP Request Smuggling — Sanitized Examples

These examples use `target.invalid` and unique nonexistent canaries. They describe interpretation and evidence shape, not production exploit chains.

## Positive: CL.TE self-owned canary

Preconditions:

- HTTP/1.1 front end and back end are evidenced;
- the endpoint is a harmless echo/error route;
- raw bytes and one dedicated keep-alive connection are available.

Candidate shape:

```text
POST /probe HTTP/1.1
Host: target.invalid
Content-Length: <outer byte count>
Transfer-Encoding: chunked

0

GET /__nullai_desync_a17f HTTP/1.1
Host: target.invalid

```

The actual test must calculate the byte count from the transmitted bytes. Send one ordinary follow-up on the same connection. Expected proof: the unique `404` canary response is associated with the tester's follow-up in the predicted sequence twice; clean-connection pairs remain normal. A timeout without this differential remains a lead.

## Positive: TE.CL self-owned canary

Candidate shape:

```text
POST /probe HTTP/1.1
Host: target.invalid
Content-Length: <inner stopping point>
Transfer-Encoding: chunked

<chunk size>
<harmless body plus canary prefix>
0

```

Expected proof: complete chunk parsing by the front end and early fixed-length termination by the back end produce the predicted difference on one tester-owned follow-up. Preserve the final zero chunk and every CRLF.

## Positive: CL.0 early response

Send headers for a small fixed-length body to a gateway-generated redirect route. If a response arrives before the declared body is transmitted, record a signal. Send the harmless canary body and one self-owned follow-up. Expected proof: the canary becomes the start of that follow-up's back-end request twice, while a body-consuming control route does not.

## Negative: standards-compliant rejection

The target returns `400`, closes the connection, and the follow-up succeeds normally on a new connection whenever both length fields appear. Expected: reject the vulnerability hypothesis and retain this as defensive behavior.

## Negative: client normalization

The captured wire bytes contain one recomputed `Content-Length` and no duplicate/ambiguous field even though the editor showed both. Expected: tool-invalid test; do not assess the server until a raw client is available.

## Negative: timing noise

Candidate timings are 0.4s and 4.9s; controls are 0.5s and 5.0s under the same gateway retry behavior. Expected: reject because the delay is not candidate-specific or repeatable.

## Negative: accepted but normalized

The front end accepts both fields, removes `Content-Length`, forwards canonical chunked bytes, and closes cleanly. The self-owned follow-up is unaffected. Expected: reject; acceptance alone is not proof.

## Ambiguous: repeatable timeout only

Two candidate requests reach the five-second client timeout while two controls return quickly. No same-connection canary test is safe in the current environment. Expected: retain a lead and explicit blocker, never a validated finding.

## Blocked: shared connection pool

The service cannot guarantee that the next back-end request belongs to the tester. Expected: stop before Stage 3 and request an isolated staging route or dedicated connection.

## Routing Controls

- Positive: “The HTTP/1 reverse proxy accepts both Transfer-Encoding and Content-Length, and a candidate-only timeout suggests CL.TE. Validate with a dedicated connection and harmless canary.” Expected primary: `http-request-smuggling`.
- Positive: “Compare HTTP/2 front-end requests with a downgraded HTTP/1 back end for H2.CL framing disagreement.” Expected primary: `http-request-smuggling`.
- Negative: “A cached response varies on an unkeyed `X-Forwarded-Host` header with no message-boundary signal.” Expected primary: `web-cache-security`, not this skill.
- Negative: “A response includes an attacker-controlled `Set-Cookie` after CRLF decoding.” Expected primary: `header-injection`, not this skill.
