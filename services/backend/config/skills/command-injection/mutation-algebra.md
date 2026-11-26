# Command Injection Mutation Algebra

Change one parser decision at a time after a canonical marker/control pair exists.

| Axis | Bounded mutations | Invariant |
|---|---|---|
| Separator | one observed-family separator or newline | marker command and request field stay fixed |
| Quote | close/reopen only the observed quote context | no additional command content |
| Argument | leading dash, end-of-options marker, or embedded space | process and filename remain fixed |
| Decode | canonical versus one URL/form/JSON encoding | decoded marker bytes are recorded |
| Shell family | POSIX *or* `cmd.exe`/PowerShell based on evidence | never spray cross-platform syntax |
| Execution channel | direct response versus known async job result | unique job id and marker stay paired |

Do not combine separator, encoding, whitespace, and quote mutations in one request. A mutation succeeds only when the unique harmless marker or bounded timing predicate survives and the paired inert control does not.
