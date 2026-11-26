# File-Upload Mutation Algebra

| Property | Safe test values |
|---|---|
| content | inert UTF-8 canary text only |
| extension | approved text extension → one mismatched benign extension |
| declared type | `text/plain` → one benign mismatch |
| filename | canonical → traversal-like separators only in a local fixture |
| access | uploader read → anonymous read of the named canary |
| lifecycle | upload once → retrieve → delete and verify removal |

No scripts, active documents, archives, polyglots, parser bombs, overwrites, or public persistence. Stop if deletion or isolated storage is unavailable.
