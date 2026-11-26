# Business Logic Examples

## Transition skip

An editor moves a synthetic record from draft directly to approved; server audit omits review and a clean session can perform the approved-only test export. Expected disposition: proof.

## Client price trust

A non-billable synthetic SKU is priced at 100, but replaying the update with client price 1 persists total 1 into server review. Cleanup occurs before payment. Expected disposition: proof.

## Idempotent retry

Two success responses share one operation id and create one balance event. Expected disposition: reject.

## Intended policy

Two discounts stack exactly as the active tenant rule specifies; a non-stackable control is denied. Expected disposition: reject.

## Irreversible requirement

The only possible observation requires a real payment and shipment. Without a sandbox/rollback, expected disposition: blocked.
