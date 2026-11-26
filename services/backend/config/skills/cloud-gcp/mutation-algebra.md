# GCP Mutation Algebra

| Axis | Bounded pair | Prohibited expansion |
|---|---|---|
| Identity | anonymous versus application test user | Google credentials/IAM |
| Object | one named synthetic object versus nonexistent | bucket/project listing |
| Compute URL | custom domain versus documented service URL | service-name guessing |
| Route | documented method with/without application auth | endpoint spraying |
| IaC | active environment value versus module default | control-plane verification |
| Cache | fresh protected marker versus public cached asset | poisoning/purge actions |

One public/source dimension changes at a time; all provider-control-plane activity remains outside the matrix.
