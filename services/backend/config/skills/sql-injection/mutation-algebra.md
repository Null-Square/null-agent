# SQL Injection Mutation Algebra

| Axis | Bounded mutation | Invariant |
|---|---|---|
| Predicate | matched true versus false | same parameter and grammar |
| Quote | numeric, single-quoted, or observed identifier context | baseline request |
| Whitespace | canonical space versus one inline comment/tab | predicate meaning |
| Comment | one database-valid terminator after dialect evidence | no stacked statement |
| Encoding | raw versus one request-channel encoding | decoded query token |
| Transport | one observed duplicate/JSON/form representation | identity and endpoint |

Do not combine dialect, encoding, comment, and transport changes. Mutations must preserve the paired predicate/control relationship and the request cap.
