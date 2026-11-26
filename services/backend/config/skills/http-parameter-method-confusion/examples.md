# HTTP Parameter and Method Confusion Examples

## Confirmed Differential

- The edge authorizes the first `role` parameter while the application consumes the last; `role=user&role=admin` changes a disposable evaluator action, and each single-parameter control behaves correctly.
- `POST` is denied for a test state change, but a documented method-override header reaches the same handler as `PATCH` without its authorization middleware.
- JSON scalar and form-array encodings bind to different server fields, and only one bypasses the intended evaluator-only validation.

## Reject

- Duplicate parameters change only error wording.
- `HEAD` returns the headers of an authorized `GET` with no body or action.
- An unsupported method returns a framework default `405`.

Change one parser or method dimension at a time. Stop after eight variants and never repeat state changes outside disposable records.
