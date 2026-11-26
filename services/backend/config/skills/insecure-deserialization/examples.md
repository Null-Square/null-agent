# Insecure Deserialization Examples

## Benign test-class construction

An isolated Java fixture accepts a client-supplied serialized object. A test-only `EvaluationCanary` class sets marker `constructed-19` in the fixture response when instantiated; a DTO control does not. No process, file, or network primitive is used. Expected disposition: proof.

## Signed state rejects mutation

Changing an evaluator-owned PHP serialized field while retaining the old MAC returns `invalid state`; an unchanged value succeeds. Verification occurs before `unserialize` in source. Expected disposition: reject.

## Library CVE without a path

A dependency scanner finds a gadget-capable library, but the deployed route uses JSON and the native deserializer is unreachable. Expected disposition: reject the runtime finding; retain dependency remediation separately if policy requires.

## Format-only signal

A cookie starts with Java serialization magic bytes, but no test account or safe object replay is available. Expected disposition: blocked, not confirmed deserialization impact.

## Prohibited proof

Do not run a gadget that launches a process or reads environment data. A benign local test type or protected-field integrity bypass is the maximum required proof.
