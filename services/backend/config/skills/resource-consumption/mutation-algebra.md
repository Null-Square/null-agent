# Resource Consumption Mutation Algebra

Every mutation inherits concurrency 1, six-candidate maximum, and the health stop envelope.

| Dimension | Bounded step | Comparison invariant |
|---|---|---|
| Count | 1x to 2x items, never an unbounded sweep | serialized element shape |
| Depth | one additional nesting level | total byte size control |
| Regex/search | literal to one wildcard or bounded expression | result-set expectation |
| Page/export | default to documented maximum | same identity and filters |
| Compression | tiny local archive with known expansion ratio | no shared upload processing |
| Cache | cold and warm pair | same semantic request |

Do not combine count, depth, fan-out, and concurrency. A valid result includes baseline distribution, candidate/control distribution, health signal, and the exact stop decision.
