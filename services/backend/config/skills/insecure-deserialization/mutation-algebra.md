# Insecure Deserialization Mutation Algebra

Preserve a byte-level baseline and change only one layer.

| Layer | Bounded mutation | Evidence |
|---|---|---|
| Envelope | raw/base64/URL-safe/compressed form actually observed | decoded byte hash |
| Integrity | unchanged, stale MAC, invalid MAC | verification order and response |
| Type | expected DTO, inert sibling, benign fixture canary | resolved type/callback marker |
| Field | one scalar or nested field | before/after test state |
| Collection | one versus two inert entries | same type graph |
| Version | deployed runtime serializer version only | exact runtime fingerprint |

Never combine a new type, nested graph, compression change, and integrity bypass. Gadget catalogs and side-effect payloads are outside this mutation algebra.
