# HTTP Request Smuggling Mutation Algebra

Mutate only after a canonical control is stable. Apply one axis at a time, calculate byte counts from the exact transmitted bytes, and retain the connection model.

## Family selection

| Observed prerequisite | First bounded family | Do not combine with |
|---|---|---|
| HTTP/1 intermediary plus back end | CL.TE or TE.CL, selected by the timeout hypothesis | TE obfuscation and route changes |
| Both hops recognize transfer coding differently | One justified TE.TE normalization case | a broad obfuscation corpus |
| Early response before body consumption | CL.0 | pause-based or browser-pool techniques |
| HTTP/2 front end with downgrade evidence | H2.CL or H2.TE | raw newline injection |

## Axes

| Axis | Safe values | Required control | Stop rule |
|---|---|---|---|
| Framing owner | front-end CL/back-end TE; front-end TE/back-end CL | canonical fixed-length and chunked requests | stop after one family is falsified twice |
| Connection | fresh; one tester-owned reused connection | same requests with `Connection: close` | stop if ownership is uncertain |
| Route owner | application response; gateway-generated error/redirect | ordinary body-consuming route | no state-changing routes |
| Protocol | HTTP/1.1; HTTP/2 with evidenced downgrade | negotiated end-to-end HTTP/2 | stop on protocol errors without downgrade evidence |
| Length delta | minimum one-boundary discrepancy | exact-length message | never add arbitrary padding |
| Transfer coding | canonical `chunked`; one architecture-justified normalization variation | canonical rejection/acceptance | maximum two variations |
| Body expectation | documented body route; apparently bodyless route | same method with empty body | stop on unstable response |

## Byte-count invariant

For every candidate record:

```text
header_octets
body_octets_transmitted
declared_content_length
decoded_chunk_octets
canary_offset
```

Recalculate after every edit. A candidate whose captured bytes do not match the table is invalid and must not enter evaluation.

## Timing invariant

Use the order `control → candidate → control → candidate` on fresh connections. The candidate signal must repeat within the five-second cap while both controls remain within the established baseline envelope. Timing establishes only a lead.

## Proof invariant

Use a fresh nonce for each same-connection pair. Proof requires the predicted effect on the tester's follow-up twice and no effect on independent controls. Never use another user's request as the second message.
