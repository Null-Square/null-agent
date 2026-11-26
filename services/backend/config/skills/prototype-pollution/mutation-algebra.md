<!-- B1-NORMALIZED-START -->
# prototype-pollution Mutation Algebra

Apply one bounded dimension at a time and retain the baseline/control pair.

| Axis | Safe variations | Stop rule |
|---|---|---|
| Identity | owner, peer, tenant peer, authorized role control | Stop without approved identities |
| State | fresh, replayed, expired, reordered, bounded concurrent | Stop at the concurrency cap |
| Parser | scalar/array/object, duplicate, canonical alternate | Stop on instability or ambiguity |
| Transport | method, content type, HTTP version, browser channel | Use only observed/supported transports |
| Encoding | canonical, percent, Unicode, case, delimiter | Never use evasions outside RoE |
| Cache | keyed/unkeyed control, fresh/cached response | Do not create broad persistence |
| Timing | repeated baseline and bounded candidate samples | Never load-test or impair availability |
| Platform | observed framework, runtime, OS, or managed service | Fingerprints remain inventory only |

Proof requires the same meaningful outcome across a clean control and the minimum repeat needed to reject noise.
<!-- B1-NORMALIZED-END -->
