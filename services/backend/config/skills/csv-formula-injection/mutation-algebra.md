# CSV Formula Injection Mutation Algebra

| Export variable | Safe values |
|---|---|
| leading character | `=`, `+`, `-`, `@` followed only by `B1_CANARY` text |
| whitespace | none → tab/space only if importer behavior is in scope |
| quoting | raw field → CSV-quoted field |
| mitigation | apostrophe prefix → literalization policy configured by exporter |
| file type | CSV only → spreadsheet format only when supplied and isolated |

Never use formula functions, URLs, commands, or external data references. Stop after identifying whether each user-controlled export column is literalized.
