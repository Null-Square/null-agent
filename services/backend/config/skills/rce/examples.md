# Remote Code Execution Synthesis Examples

These examples assume an upstream skill has already demonstrated the vulnerable primitive.

## Positive: synchronous owner canary

Upstream evidence identifies a test-only expression sink and the owner has installed `eval_nonce(value)`, which returns only its argument.

Control:

```json
{"template":"Invoice {{customer_name}}","customer_name":"B1 control"}
```

Candidate:

```json
{"template":"Invoice {{eval_nonce('8f2c7a')}}","customer_name":"B1 control"}
```

Invalid-canary control:

```json
{"template":"Invoice {{eval_noncx('8f2c7a')}}","customer_name":"B1 control"}
```

Generate a second nonce for replay. Proof is two exact candidate nonces, no nonce from the invalid function, and a source trace to the execution API.

## Positive: asynchronous disposable marker

The owner-provided test harness exposes a canary that writes a nonce to:

```text
/workspace/b1-rce/run-7f3a/canary.txt
```

The evaluator records the directory as absent, submits one job, correlates its identifier, observes only the nonce, and deletes the marker. A job with the invalid canary name does not create it.

No other path, output, or runtime property is inspected.

## Positive: nonce-only callback

For a blind sink, the approved canary makes one request to:

```text
https://eval-callback.example/b1-rce/7f3a/8f2c7a
```

The callback captures time, source, method, and nonce. It returns an inert response and carries no application data. A second nonce reproduces once; an invalid canary does not.

## Negative: reflected payload

The response contains the candidate string inside a validation error, including the nonce, but the canary function is never invoked and the invalid control is identical. This is reflection, not execution.

## Negative: restricted expression

Arithmetic or property access works in a documented expression language, but the owner canary is unavailable and source confirms the evaluator cannot reach a general execution API. Retain the upstream template finding, not an RCE conclusion.

## Ambiguous: uncorrelated callback

The callback monitor sees a request without the run nonce or outside the job time window. It may be a health check or scanner. Repeat once with a fresh nonce; otherwise reject RCE proof.

## Blocked: no safe canary

The upstream injection is reproducible, but the target is shared and the owner has not installed an inert canary. Record:

- upstream evidence identifiers;
- suspected execution API;
- requested disposable environment or canary;
- impact as untested.

Do not strengthen the payload.

## Routing controls

- Positive: “Confirm the proven template primitive reaches the owner-installed nonce canary, then stop.” Expected: `rce`.
- Negative: “Discover whether the `host` field accepts shell metacharacters.” Expected: `command-injection`; RCE synthesis is premature.
