# Client-Side Trust Boundary Examples

## Accepted Proof

- The UI hides `plan=enterprise`, but changing that request field from `trial` to `enterprise` causes the server to create a synthetic enterprise entitlement. The server response and follow-up read both confirm state.
- A price value calculated in JavaScript is accepted unchanged by checkout for an evaluator-only zero-value test product; the server receipt records the client-supplied amount.

## Controls

- Editing a React state value changes only the display; the API independently calculates the original price. Reject.
- A hidden `isAdmin` field is transmitted but ignored, and the returned role remains `member`. Reject.
- Source maps expose feature names without a server-accepted trust decision. Inventory only.

## Limits

Use one-field changes on disposable objects. Missing test checkout or entitlement cleanup makes the case `blocked`, not proof.
