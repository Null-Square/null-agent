# DOM XSS Examples

## Confirmed Sink Reachability

- The URL fragment `#B1-7` reaches `innerHTML`; substituting a non-networking DOM marker creates exactly one inert element in an owner test page. The source-to-sink trace and clean `textContent` control establish proof.
- A `postMessage` from an owner-controlled sibling origin reaches `insertAdjacentHTML` because the listener has no origin check. A random-origin control is also accepted.

## Rejected

- A marker is reflected into a text node after HTML encoding.
- Static code mentions `eval`, but the candidate value cannot reach it.
- A browser extension, not application code, mutates the DOM.

## Ambiguous

Minified source suggests a sink but runtime instrumentation loses the value through an unknown transform. Retain the trace as a lead. Do not use network callbacks, cookie reads, or session-impact payloads.
