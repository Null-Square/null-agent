# CSV Formula Injection Examples

## Safe Positive

Export an evaluator-owned row whose display name begins with the inert marker `=B1_CANARY_7`. Inspect the produced CSV offline: the cell begins with `=` and is not neutralized. Open only in an isolated viewer configured not to follow links or run external actions. Proof is unsafe formula interpretation potential in a named export field, not execution against another user.

## Negative Controls

- The export prefixes formula-leading values with an apostrophe and preserves the visible marker.
- The value is quoted but still interpreted as a formula; quoting alone is not a negative control.
- A CSV library version is present, but no attacker-controlled field reaches an export.

## Blocked

If no disposable export or safe offline viewer is available, record the field-to-export mapping as a lead. Never use command, URL-fetch, or data-exfiltration formulas.
