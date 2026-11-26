# Firebase and Firestore Examples

## Proof

- An unauthenticated SDK read returns the named evaluator document `b1/canary-7`, while a nonexistent document and authenticated owner read provide controls.
- Evaluator A writes only its disposable document under a rule that incorrectly compares `request.auth.uid` to an attacker-controlled field; a follow-up read confirms the one-field state change.
- Storage rules allow reading a named synthetic object that supplied configuration marks private.

## Not Proof

- Firebase project ID, API key, and auth domain appear in the web bundle.
- Emulator rules are permissive but production deployment cannot be established.
- A collection name is discoverable without document access.

No collection enumeration, bulk reads, rule deployment, account creation, or discovered credential use. Block when project/environment or document ownership is uncertain.
