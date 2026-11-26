# Browser Tooling Examples

## Appropriate Use

- Capture an evaluator login redirect, cookie attributes, and network request IDs while preserving origin and timing.
- Run an owner-hosted inert DOM marker to determine whether a fragment reaches a sink.
- Compare a CORS request from the application origin and an owner-controlled test origin in the same browser engine.

## Inappropriate Use

- Clicking destructive controls “to see what happens.”
- Allowing a password manager or unrelated authenticated profile to populate the session.
- Treating rendered text as raw HTTP evidence when proxy or network capture is required.

Use a clean evaluator profile, disable unrelated extensions, cap tabs and actions, and clear storage afterward. The browser supplies evidence; the domain skill decides the finding.
