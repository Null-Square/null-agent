# Race-Condition Mutation Algebra

| Variable | Values |
|---|---|
| action | one disposable idempotent or resettable evaluator action |
| baseline | three sequential requests |
| concurrency | two simultaneous, then four only if stable and approved |
| synchronization | normal dispatch → one barrier-aligned batch |
| identity | same evaluator session unless cross-session is the hypothesis |
| invariant | exact expected count/balance/state read after each batch |

Stop on latency/error rise, invariant uncertainty, or first deterministic duplicate transition. Never test scarce inventory, billing, quotas, or availability.
