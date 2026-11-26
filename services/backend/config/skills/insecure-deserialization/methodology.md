# Insecure Deserialization Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Apply when an in-scope endpoint, cookie, queue message, uploaded artifact, cache entry, or source dataflow accepts a serialized object format rather than ordinary JSON data. Identify the format and trust boundary first: Java serialization, .NET BinaryFormatter/DataContract, PHP serialization, Python pickle, Ruby Marshal, YAML object tags, or framework-specific signed state.

Base64, opaque cookies, stack traces, and library versions are inventory. Do not decode or mutate real user state. Use only evaluator-owned objects and a local or isolated target where object construction has no external effects.

## Surface Discovery and Prioritization

1. Record magic bytes, MIME type, framing, compression, signing/MAC wrapper, and content origin.
2. In source mode, trace bytes through decoding, integrity verification, type resolution, allowlists, and object callbacks.
3. Separate unsafe native object reconstruction from safe data-only serializers.
4. Prioritize unsigned or incorrectly verified values crossing from a lower-trust client/tenant into privileged server processing.

## Safe Test Ladder

1. Replay an unchanged evaluator-owned object and an invalid-format control.
2. Change one harmless scalar field while preserving framing and integrity rules; determine whether the server accepts attacker-created state.
3. Use a benign class/type canary available only in the local fixture or test application. Its constructor may set a test-local marker and must not start processes, read files, or use the network.
4. Pair with a data-only type or disallowed-type control.
5. Stop at deterministic unauthorized type construction, integrity bypass, or protected state manipulation.

Do not use public gadget chains, calculator processes, file/network callbacks, denial payloads, or production session forgery. Limit to four candidate objects per endpoint and one at a time.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Variation Matrix

- Envelope: raw bytes, base64, compressed, URL-safe, cookie, or message frame.
- Integrity: absent, valid evaluator signature, invalid MAC, modified payload with stale MAC.
- Type resolution: exact expected type, data-only sibling, benign test canary, disallowed type.
- Field shape: scalar, collection, nested object, or unexpected property.
- Lifecycle callback: constructor, property setter, validation hook, or post-load callback observed in source.
- Runtime: only the deployed language/framework version and local fixture version.

## Proof Standard

Proof requires deterministic acceptance of attacker-controlled object state across a trust boundary or construction/callback of a benign test type, with a matched safe-type or integrity control. A dangerous API in unreachable source, dependency CVE, parser exception, or unsigned-looking blob is a lead.

## False Positives and Benign Lookalikes

1. The value is JSON or another data-only format despite a serialized appearance.
2. A valid signature is checked before deserialization and every mutation is rejected.
3. The application deserializes only an explicit sealed allowlist of inert DTO types.
4. An error names a native serializer but occurs before any attacker-controlled type resolution.
5. A scanner matches a library version without a reachable untrusted dataflow or compatible type path.

## Missing Prerequisites and Blocked Behavior

Block when no evaluator-owned object can be produced, integrity keys would be required, the format cannot be identified, or only unsafe gadget execution could confirm the path. Record the exact envelope, sink, and benign fixture needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `file_read` and connected-repository reads for byte-to-sink tracing, `python_session` for offline envelope parsing without object construction, and HTTP replay for bounded test objects. Scanner and dependency results inform reachability but never authorize gadget execution.

## Handoffs and Duplicate Prevention

Hand signature/key confusion to the owning session or token skill, source dataflow to `source-aware-whitebox`, and the proven primitive to `validation`. `rce` may synthesize impact without running a gadget. YAML injection owned by `secondary-server-injections` should not duplicate native object reconstruction.

## Stop, Cleanup, and Data Minimization

Delete test objects and queue messages, remove local canary markers, and retain only sanitized bytes or hashes, type names, controls, and server response. Stop after one benign constructor/callback proof or two incompatible format hypotheses.

## Sources

- [OWASP Deserialization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html)
- [CWE-502: Deserialization of Untrusted Data](https://cwe.mitre.org/data/definitions/502.html)
