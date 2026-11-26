# Webhook Mutation Algebra

| Binding | One-variable test |
|---|---|
| signature bytes | recorded raw body ↔ one changed field |
| key/tenant | evaluator endpoint A ↔ evaluator endpoint B |
| time | current timestamp ↔ just outside documented window |
| event id | first delivery ↔ one replay |
| ordering | two disposable lifecycle events in reversed order |
| consumer state | pre-read ↔ post-read of synthetic record |

Use recorded/synthetic events, owner keys, two replays maximum, and immediate cleanup. Do not impersonate providers or create non-disposable effects.
