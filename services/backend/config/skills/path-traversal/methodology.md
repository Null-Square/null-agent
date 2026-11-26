# Path Traversal Methodology

Use this method to test whether an application-controlled path can escape its intended directory, archive root, or object-key prefix. Proof uses evaluator-owned marker data placed for this purpose; production operating-system and application-secret files are never test targets.

## Preconditions and Fast Applicability

Require:

- an authorized endpoint whose input selects a file, template, export, import, archive member, media object, or storage key;
- a known successful request for an allowed evaluator-owned file;
- a unique marker file or object placed immediately outside the intended test directory but inside a dedicated evaluation sandbox;
- the intended base directory or key prefix, supplied by the owner or derived from white-box evidence; and
- a maximum normalization depth.

Default limits are four parent segments, twelve total requests per parameter, and one archive extraction job. If the owner cannot place a marker outside the allowed root, dynamic read proof is blocked; continue only with source-level path analysis.

## Surface Discovery and Prioritization

Inventory each path-bearing input and its transformation:

| Surface | Questions |
|---|---|
| download/view | Does an identifier map to a path, or is the path accepted directly? |
| template/include | Is a suffix or base directory added before canonicalization? |
| upload filename | Is the client filename preserved, renamed, or joined to a storage root? |
| archive import | Are member names normalized before extraction? |
| object storage | Is a tenant or user prefix enforced after decoding? |
| export/report | Is a generated filename later used by another worker? |

Prioritize surfaces where the same input crosses a gateway, framework decoder, and filesystem or storage SDK because inconsistent decoding creates exploitable gaps.

## Safe Test Ladder

### 1. Establish controls

Request:

- the allowed marker by its normal basename;
- a nonexistent basename of the same shape; and
- the outside-root marker without traversal syntax, which should fail.

Capture status, normalized content length, cache status, and the unique marker value.

### 2. Single parent transition

Replace only the basename with one parent segment followed by the outside-root marker name. If the intended directory is nested more deeply, add one parent segment per request up to the agreed maximum. Stop immediately when the unique marker is returned.

### 3. Decoder disagreement

Only when the plain transition is rejected, test these classes one at a time:

- URL encoding at one layer;
- double encoding when two documented decode layers exist;
- alternate separator accepted by the target platform;
- nested separator form when a filter removes one pass;
- required prefix followed by a parent transition; and
- required suffix handling using an inert marker extension.

Do not use unbounded payload lists. Two representations per applicable class is the maximum.

### 4. Object-key prefix escape

For object storage, place two evaluator-owned objects: one inside and one adjacent to the assigned prefix. Compare canonical keys and authorization results. A different tenant’s data is never an acceptable marker.

### 5. Archive extraction

Run only in an owner-provided disposable extraction directory. The archive contains:

- one normal member with a random name;
- one member that would resolve to a sibling marker path; and
- no executable, active, or oversized content.

Proof is the sibling marker appearing inside the disposable parent directory. Do not target an existing filename, startup directory, web root, or configuration location.

## Variation Matrix

Track each transformation rather than mixing payloads:

| Axis | Variants |
|---|---|
| parent depth | 1 through owner-approved maximum |
| encoding | literal, once encoded, twice encoded only with two decoders |
| separator | target-native, target-supported alternate |
| anchoring | relative, approved base prefix plus relative |
| suffix | none, expected inert extension |
| operation | read, archive extract, object-key lookup |
| execution path | synchronous request, known background worker |

For asynchronous paths, correlate the request, job identifier, completion event, and marker observation.

## Proof Standard

Dynamic proof requires all of:

1. the normal in-root marker succeeds;
2. the adjacent marker is not accessible by its unmodified name;
3. one path variation returns or creates the exact unique adjacent marker;
4. a nonexistent sibling control does not produce the same result; and
5. the canonical boundary and normalization sequence can be explained.

White-box proof requires a user-controlled path reaching a filesystem or storage operation after inadequate canonical-boundary enforcement, plus a test demonstrating the effective resolved path in a sandbox.

Errors, timing changes, generic file content, or an unverified `200` are not proof.

## False Positives and Benign Lookalikes

- A route may map names through a database rather than use them as paths.
- A gateway may decode input but the application may still canonicalize safely.
- A custom error page can have the same length as the marker response.
- Object storage can intentionally expose a shared public prefix.
- Archive libraries can report unsafe member names while refusing extraction.
- A cache can return an earlier allowed object after the request path changes.

Use a random marker per run and bypass or purge only evaluator-owned cache entries.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when there is no evaluator-owned adjacent marker, the base boundary is unknown, archive extraction is not disposable, or the only available proof would read production host data. Source review may produce a lead, but not a validated dynamic finding.

State the needed marker location, boundary information, and safe replay. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for exact request replays and response hashing. Use repository or artifact inspection for white-box canonicalization paths. Browser tooling is appropriate only when a download token or background job must be created through the UI.

If the endpoint signs filenames, obtain a second signed evaluator marker through the normal workflow; do not forge credentials or expand scope.

## Handoffs and Duplicate Prevention

- Hand authorization failures on opaque object identifiers to `idor`.
- Hand upload acceptance and serving policy to `insecure-file-uploads`.
- Hand parser-triggered XML references to `xxe`.
- Hand storage bucket policy to the applicable cloud skill.
- Hand execution impact to `rce` only after this skill has documented the safe path-boundary proof.

This skill owns normalization and root/prefix escape evidence. Refer to the same exchange rather than filing duplicate symptoms.

## Stop, Cleanup, and Data Minimization

Stop on first exact marker proof, at twelve requests for the parameter, or on unexpected writes. Delete evaluator-created archive outputs and adjacent markers after evidence capture. Keep only marker hashes, normalized paths, and redacted exchanges.

Never perform destructive actions, overwrite existing files, read host secrets, or place content in an executable location.

Research date: 2026-07-23

## Sources

- OWASP Web Security Testing Guide, Directory Traversal/File Include: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/11-Testing_for_File_Inclusion
- PortSwigger Web Security Academy, Path Traversal: https://portswigger.net/web-security/file-path-traversal
- CWE-22, Improper Limitation of a Pathname to a Restricted Directory: https://cwe.mitre.org/data/definitions/22.html
