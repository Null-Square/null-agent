# Auth0 Platform Examples

## Platform-Specific Proof

- An evaluator application's unregistered callback is accepted and the authorization response arrives at an owner-controlled callback distinct from the registered URI. Preserve tenant, client, and callback evidence.
- An evaluator from Organization A obtains an application session labeled as Organization B, and the resource server corroborates the wrong organization context.

## Non-Findings

- A client identifier appears in JavaScript. Auth0 client IDs are not secrets.
- Two callback URLs both succeed and both are present in the supplied tenant configuration.
- A custom claim is absent from an access token because the API audience was not requested.

## Blocked and Handoff

- Without tenant/client provenance or evaluator identities, record the exact missing input and stop.
- Token signature and claim-validation flaws route to `jwt-attacks`; generic redirect binding routes to `oauth-oidc`.
