# Secondary Server Injection Examples

## Candidate Classes

- An evaluator marker reaches an LDAP filter without escaping and changes a query from exact-match to an additional synthetic directory entry. The directory is a disposable fixture and an escaped control is retained.
- A search value changes an XPath predicate and returns a second synthetic XML record; malformed syntax alone is not proof.
- User-controlled text becomes part of a mail header and creates a second inert `X-B1` field in the evaluator mailbox.

## Rejections

- Input produces a generic backend error with no deterministic query or message effect.
- A sink API appears in dead source.
- The marker is escaped before the interpreter boundary.

Do not target OS commands, SQL, templates, or NoSQL here; route those to their primary skills. Stop at one harmless synthetic differential.
