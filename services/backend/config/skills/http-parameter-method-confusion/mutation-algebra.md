# Parameter/Method Confusion Mutation Algebra

| Axis | Minimal set |
|---|---|
| duplicate order | `a=owner&a=peer` ↔ reversed order |
| shape | scalar ↔ array only where schema permits |
| location | query ↔ body for the same named field |
| media type | JSON ↔ form if both handlers exist |
| method | canonical verb ↔ documented override mechanism |
| path | canonical normalization ↔ one observed alternate |

Use one synthetic action and reset it between variants. A parsing/error difference without authorization or validation impact is rejected.
