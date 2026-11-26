# Header Injection Examples

## Positive

- An evaluator profile value containing the encoded inert marker `B1-Header: yes` causes a second response header after the application decodes it. Raw capture shows two distinct header fields; a canonical marker control remains within the original value.
- A redirect parameter injects a harmless cookie attribute into the evaluator response through a CR/LF normalization mismatch. No security cookie is overwritten.

## Negative

- The marker appears percent-encoded inside one `Location` value.
- A proxy adds a diagnostic header independently of user input.
- The client UI splits lines, but raw HTTP has one header.

## Boundary

Proof requires raw wire-level structure and a one-variable control. Do not inject cache directives, security-header removal, cookies for other users, or response bodies.
