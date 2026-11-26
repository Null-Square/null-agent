# Evidence Validation Examples

## Validate

- Reproduce an IDOR with fresh evaluator sessions, owner/peer/nonexistent object controls, matching response fields, and the synthetic peer canary.
- Confirm a source-reported missing authorization guard maps to the deployed route and current commit.
- Minimize an injection candidate to one changed input and show the semantic result disappears with a patched control.

## Reject

- A single `500`, timing outlier, scanner label, or reflected marker with no interpreter effect.
- Evidence whose request target is outside the current allowlist.
- A screenshot without raw request/response identity, time, or provenance.

## Block

If safe reproduction would require non-evaluator data, privileged credentials, destructive state, or a prohibited chain, mark validation blocked and state the least additional evidence required. Validation cannot expand scope.
