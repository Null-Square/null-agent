# XSS Mutation Algebra

| Axis | One-step mutation | Invariant |
|---|---|---|
| Context | text, quoted/unquoted attribute, JS data, URL | same server sink |
| Delimiter | canonical versus one encoded form | page-local marker |
| Interaction | parse-time versus one documented event | same test user |
| Lifecycle | reflected versus stored render | fresh marker |
| Browser | clean profile A versus B | same raw response |
| Policy | nonce-bearing control versus candidate | CSP captured |

Do not combine context breakout, multi-encoding, event families, and navigation. A mutation passes only with real browser execution and an inert encoded control.
