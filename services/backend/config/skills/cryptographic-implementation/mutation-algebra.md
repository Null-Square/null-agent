# Cryptographic Implementation Mutation Algebra

| Property | Comparison |
|---|---|
| algorithm/mode | configured primitive against current approved policy |
| key provenance | test key id ↔ effective runtime key id; values never retained |
| nonce/IV | two supplied messages under the same key id |
| salt/work factor | sanitized hash records and active encoder configuration |
| signature input | canonical artifact ↔ one changed semantic field |
| verification order | verify-before-consume ↔ source-observed consume path |

Use offline fixtures and metadata. Do not crack secrets, recover plaintext, weaken live configuration, or reuse production key material.
