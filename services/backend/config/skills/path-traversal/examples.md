# Path Traversal Examples

All examples assume the owner created this disposable layout:

```text
/workspace/b1-path/run-7f3a/
  public/
    welcome-7f3a.txt        # normal allowed marker
  adjacent-7f3a.txt         # outside public/, inside evaluator sandbox
```

The exact marker values are recorded before testing and deleted afterward.

## Positive: one-level read escape

Baseline:

```http
GET /download?name=welcome-7f3a.txt
```

Candidate:

```http
GET /download?name=../adjacent-7f3a.txt
```

Negative control:

```http
GET /download?name=../absent-7f3a.txt
```

Expected proof: the baseline returns the allowed marker, the candidate returns the exact adjacent marker, and the absent control does not. The evidence records that both files are evaluator-owned and the candidate crossed only the intended test boundary.

## Positive: one decode disagreement

When a gateway decodes once and the application is known to decode again:

```http
GET /download?name=..%252Fadjacent-7f3a.txt
```

Run this only after the literal and once-encoded controls. Record the request representation observed at each decode layer. Do not test additional encodings when the architecture has only one decoder.

## Positive: object-key prefix

Evaluator objects:

```text
tenant-a/run-7f3a/inside.txt
tenant-a/adjacent-7f3a.txt
```

The assigned prefix is `tenant-a/run-7f3a/`. A request using `../adjacent-7f3a.txt` returns the adjacent evaluator marker while a request using `../absent-7f3a.txt` fails. The finding is prefix escape; no other tenant is queried.

## Positive: disposable archive extraction

The archive contains two inert text members:

```text
normal-7f3a.txt
../adjacent-output-7f3a.txt
```

Extraction occurs only under `/workspace/b1-path/extract-7f3a/`. Proof is the second marker appearing in its disposable parent. The filename is random and known not to exist before extraction.

## Negative: canonicalization before access

The candidate returns the same policy error as the absent control. Application logs or source show the joined path is canonicalized, then rejected because it does not start with the allowed directory plus a separator. Record the defense as effective.

## Negative: identifier, not a path

Changing `document_id=welcome-7f3a` to path-like syntax produces an input-schema error and never reaches a storage API. This is not path traversal. If another evaluator identity can access the document identifier, hand that separate hypothesis to `idor`.

## Ambiguous: generic error

The candidate returns `500`, but neither marker appears and no canonical path is available. Repeat once with the absent control. If both fail equivalently, retain no finding; if they differ without marker proof, record a bounded lead.

## Blocked: no evaluator marker

The route clearly joins a filename to a base directory, but the owner cannot place an adjacent test file and source is unavailable. Record:

- the exact sink-bearing parameter;
- the normal baseline;
- the missing adjacent marker prerequisite; and
- the safe layout requested from the owner.

Do not use production files as substitutes.

## Routing controls

- Positive: “Validate whether the report download filename escapes its evaluator sandbox after URL decoding.” Expected: `path-traversal` ranks in the top three.
- Negative: “Check whether account A can read account B’s opaque invoice identifier.” Expected: `idor`, not `path-traversal`, owns the task.
