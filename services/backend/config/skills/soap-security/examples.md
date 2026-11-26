# SOAP Security Examples

## SOAP-Aware Proof

- A supplied WSDL operation marked authenticated accepts an anonymous envelope and returns the synthetic `B1_SOAP_3` field.
- Evaluator A changes one resource element and receives evaluator B's canary; an owner envelope and nonexistent resource are controls.
- A WS-Security timestamp from an evaluator message is replayed once outside the configured window and a harmless idempotent operation is accepted.

## Reject

- WSDL disclosure lists public operations only.
- A SOAP fault reveals operation names without data or state.
- An XML parser rejects an unknown namespace or malformed envelope.

Use supplied WSDL/schema, no more than three envelopes per operation, and no entity expansion or parser stress. XML entity behavior routes to `xxe`.
