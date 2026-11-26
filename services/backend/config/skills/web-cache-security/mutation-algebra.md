# Web Cache Mutation Algebra

| Cache variable | Candidate/control |
|---|---|
| key input | canonical request ↔ one owner-controlled unkeyed candidate |
| state | cold unique key → primed key → canonical fetch |
| identity | evaluator private response → anonymous fetch |
| normalization | one observed path/query normalization difference |
| tier | browser bypassed; CDN/reverse-proxy status recorded separately |
| persistence | one repeat with a new synthetic canary |

Use unique low-traffic test keys and two persistence checks maximum. Never target shared high-traffic pages or real-user content.
