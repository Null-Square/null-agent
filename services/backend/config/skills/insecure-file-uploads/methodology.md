# Insecure File Upload Methodology

Use this method to evaluate extension, media-type, filename, storage, retrieval, and processing controls with inert evaluator-owned files. Active server payloads, malware, macros, and persistent browser code are outside this method.

## Preconditions and Fast Applicability

Require:

- an authorized upload or import route and one evaluator-owned account;
- documented or observed allowed file types and maximum size;
- a normal accepted file smaller than 100 KiB;
- a unique per-run marker in every test file; and
- a way to delete uploaded artifacts or an owner-confirmed automatic expiry.

Default limits are twelve uploads for one control set, files no larger than 100 KiB, no decompressed content above 500 KiB, and one retrieval per accepted artifact. If processing can notify or affect another user, use an isolated test tenant.

## Surface Discovery and Prioritization

Map the full lifecycle rather than only the POST response:

`client selection -> multipart/API parsing -> validation -> rename -> storage -> processing -> serving -> deletion`

Record:

- accepted field names, extensions, declared media types, and detected media types;
- whether the original filename is retained;
- synchronous or asynchronous processing;
- storage host, path shape, authorization, and expiry;
- response `Content-Type`, `Content-Disposition`, and anti-sniffing headers; and
- whether the object is transformed before serving.

Prioritize inconsistent enforcement between direct upload APIs, multipart routes, mobile routes, and background processors.

## Safe Test Ladder

### 1. Baseline and rejection controls

Upload one documented allowed file containing the nonce. Then upload one clearly unsupported inert text file. Confirm that validation occurs server-side by replaying without client-side checks.

### 2. Extension and media-type disagreement

Create an inert marker file whose extension, declared media type, and magic bytes can be varied independently. Test:

- correct extension, type, and bytes;
- allowed extension with mismatched declared type;
- allowed declared type with mismatched bytes;
- case variation of the extension; and
- one additional suffix after the allowed extension.

No file contains executable server or browser instructions.

### 3. Filename normalization

Use random filenames to test duplicate names, Unicode normalization, a single parent segment, and separator handling. The target is an evaluator-owned disposable upload namespace. Never choose an existing filename or operational directory.

### 4. Retrieval policy

For an accepted inert artifact, record:

- whether an unauthenticated request can retrieve it;
- whether a second evaluator account can retrieve it when isolation is expected;
- the response media type and disposition; and
- whether the platform sets a safe, generated filename.

Use `idor` as primary for cross-account authorization proof.

### 5. Processing

Use format-valid but inert fixtures: a tiny image, a text PDF, or a minimal archive containing one text marker. Observe scan state, transformation, metadata removal, and failure handling. The archive contains no links, nested archives, active content, or path outside its disposable extraction root.

### 6. Owner-provided execution canary

Only in a disposable environment where the owner has installed a harmless upload-canary handler, upload its documented nonce-only fixture once. A normal production server is not an acceptable place to test executable handling. Without that precondition, report unsafe storage/serving evidence and mark execution impact untested.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| extension | allowed, case variant, extra suffix, unsupported |
| declared media type | expected, generic binary, mismatched |
| detected content | expected magic, inert text mismatch |
| filename | random, duplicate, normalized Unicode, one parent segment |
| identity | owner account, second evaluator account, anonymous |
| lifecycle | upload response, processed state, retrieval, deletion |
| route | documented UI/API route, one authorized alternate route |

Change one axis at a time so the failing control is attributable.

## Proof Standard

A finding requires an accepted inert artifact plus evidence of a material control failure, such as:

- server-side validation accepts a prohibited type based on a client-controlled attribute;
- a filename resolves outside the assigned disposable namespace;
- an artifact is served with an active interpretation contrary to policy;
- an unauthorized identity retrieves protected evaluator data;
- a processor performs an unsafe transformation observable with the marker; or
- the owner-provided canary handler evaluates a nonce-only fixture.

An upload `200`, a stored filename, client-side rejection bypass, or extension mismatch without unsafe serving or processing is a lead.

## False Positives and Benign Lookalikes

- The upload response can succeed while the asynchronous scanner later quarantines the file.
- A CDN may serve an old object at a reused name.
- A declared media type may be ignored because server-side detection is correct.
- Public retrieval may be intended for a published asset workflow.
- A file can be renamed while the response displays the original filename.
- A thumbnailer can safely strip the original content and serve only its output.

Wait for the final processing state and use a fresh nonce for every artifact.

## Missing Prerequisites and Blocked Behavior

Return `blocked` for execution impact when no disposable canary handler exists. Return `blocked` for lifecycle conclusions when deletion, processing state, or retrieval cannot be observed. Do not upload active code or oversized files to compensate.

Record the exact untested stage. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling to capture signed multipart flows and `http_payload` for controlled replays. Use local file inspection to verify fixture bytes before upload. Use `report_note` for the lifecycle matrix and artifact cleanup log.

If a presigned storage request is used, create it through the normal evaluator account and preserve the signed field names while varying only the selected test dimension.

## Handoffs and Duplicate Prevention

- Hand cross-account retrieval to `idor`.
- Hand filename root escape or archive member escape to `path-traversal`.
- Hand XML parser behavior in accepted documents to `xxe`.
- Hand stored browser execution to `xss`.
- Hand resource-limit behavior to `resource-consumption`.
- Hand proven nonce-only server evaluation to `rce`.

This skill owns upload validation, storage, processing, and serving policy. Link shared exchanges rather than duplicate findings.

## Stop, Cleanup, and Data Minimization

Stop at the first reproducible material failure, twelve uploads, unexpected processing, or inability to delete artifacts. Delete every accepted test object and verify retrieval fails afterward. Retain fixture hashes and redacted request metadata, not object contents beyond the nonce.

Never perform destructive actions, overwrite existing objects, upload active payloads, or create files intended to persist.

Research date: 2026-07-23

## Sources

- OWASP WSTG, Test Upload of Unexpected File Types: https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/10-Business_Logic_Testing/08-Test_Upload_of_Unexpected_File_Types
- OWASP WSTG, Test Upload of Malicious Files: https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/10-Business_Logic_Testing/09-Test_Upload_of_Malicious_Files
- PortSwigger Web Security Academy, File Upload Vulnerabilities: https://portswigger.net/web-security/file-upload
- CWE-434, Unrestricted Upload of File with Dangerous Type: https://cwe.mitre.org/data/definitions/434.html
