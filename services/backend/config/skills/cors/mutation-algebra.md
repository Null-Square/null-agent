# CORS Mutation Algebra

Test browser-enforced reads in this order:

| Origin class | Example role |
|---|---|
| absent | non-CORS baseline |
| canonical application | expected allow |
| owner-controlled unrelated | expected deny |
| prefix/suffix lookalike | regex boundary control |
| `null` | only when the application supports sandbox/file contexts |

For each origin, compare preflight and actual response, credentials off/on, and public/private synthetic resources. Stop after ten browser requests; a header without readable private content is not proof.
