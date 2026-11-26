# Firebase/Firestore Mutation Algebra

| Surface | Bounded values |
|---|---|
| auth | unauthenticated → evaluator A → evaluator B |
| document | named owned path → named peer synthetic path → nonexistent |
| operation | single get → single disposable write if approved |
| rule expression | active deployed rule matched to request variables |
| storage | named public object → named private synthetic object |
| environment | emulator versus production project must never be conflated |

Never list collections/buckets or use admin/service credentials. Stop when project id, deployed ruleset, or ownership cannot be established.
