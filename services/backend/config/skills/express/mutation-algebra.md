# Express Mutation Algebra

1. Map router mount prefix and effective middleware order.
2. Compare canonical path with one observed encoded/trailing-slash form.
3. Compare evaluator/no-session at the same handler.
4. Vary one proxy header only when `trust proxy` and edge provenance are known.
5. Vary JSON/form binding only when both parsers are mounted.
6. Confirm any state through a disposable record read.

Stop at eight requests per handler. Do not add middleware, change environment, or exercise process/command APIs.
