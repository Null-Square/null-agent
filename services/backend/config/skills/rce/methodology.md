# Remote Code Execution Synthesis Methodology

This skill validates whether an already identified execution primitive crosses into server-side code execution. It does not rediscover command injection, template injection, deserialization, or file inclusion from scratch, and it does not explore the host after proof.

## Preconditions and Fast Applicability

Require a lead from `command-injection`, `ssti`, `insecure-deserialization`, `path-traversal`, `insecure-file-uploads`, or an equivalent white-box sink trace. The lead must identify:

- the exact input and execution sink;
- an evaluator-owned target or isolated test environment;
- an owner-approved canary mechanism;
- the maximum request count and expected cleanup; and
- whether the execution path is synchronous or tied to a known job.

An acceptable canary is a preinstalled test function that returns a random nonce, a disposable sandbox marker with an exact approved path, or a test harness callback that carries only the nonce. If no canary is available, record the lead as blocked. Never substitute host enumeration or general-purpose commands.

Default limit: one baseline plus three canary attempts for one sink.

## Surface Discovery and Prioritization

Normalize upstream leads into an execution graph:

`input -> parser/decoder -> vulnerable primitive -> execution API -> canary observation`

Record each transformation, runtime boundary, privilege boundary, and asynchronous queue. Prioritize the shortest graph with the strongest upstream evidence. Do not broaden to adjacent parameters after a canary fails; return the lead to its primary skill.

White-box evidence should name the callable API, reachable code path, and configuration that enables execution. A dangerous library import without a reachable path is not applicable.

## Safe Test Ladder

### 1. Baseline

Replay the upstream control request without an execution marker. Capture status, normalized body, duration, correlation identifier, and any known job state.

### 2. Syntax-neutral canary

Invoke only the owner-provided test function or fixture syntax. The canary output must be a newly generated 128-bit nonce and no environment data. If the primitive is blind, the callback path contains only that nonce.

### 3. Independent replay

Generate a second nonce and repeat once with a fresh session or job. A cached first result is not confirmation.

### 4. Negative control

Change one character in the canary function name or fixture identifier. The negative control must not produce the nonce observation.

### 5. White-box corroboration

When source is available, map the exact input to the execution API and confirm that the observed canary path matches that code. Source corroboration raises confidence but does not replace dynamic proof unless dynamic testing is explicitly unavailable.

Stop after the negative control. Do not query identity, network, environment, filesystem inventory, cloud metadata, or neighboring services.

## Variation Matrix

Only dimensions required to establish the same primitive may vary:

| Dimension | Allowed variants |
|---|---|
| observation | direct nonce response, disposable sandbox marker, nonce-only callback |
| processing | synchronous request, owner-identified background job |
| runtime | one confirmed reachable runtime |
| encoding | baseline representation, one encoding required by the upstream parser |
| replay | first nonce, second independent nonce, invalid-canary control |

Different sink families are separate upstream hypotheses. Do not chain them inside this method.

## Proof Standard

RCE proof requires:

1. a mapped input-to-execution path;
2. an owner-approved canary with no operational side effect beyond its nonce;
3. two distinct nonce observations;
4. one invalid-canary negative control;
5. correlation to the exact request or job; and
6. cleanup confirmation for any disposable marker.

A stack trace, template expression result, deserialization callback, parser crash, timing anomaly, or upstream injection alone is not RCE proof.

The finding scope is the demonstrated execution context only. Do not claim broader host, network, or credential impact without a separate, newly authorized assessment outside B1.

## False Positives and Benign Lookalikes

- The application may echo the canary string without executing it.
- A background worker may replay an old job result.
- A test harness can respond before the application reaches the suspected sink.
- A file may be stored successfully but never evaluated.
- A template engine may evaluate arithmetic in a restricted expression language.
- A nonce callback may originate from a scanner or gateway rather than the target.

Correlate source, timestamp, job identifier, and invalid-canary control.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when the upstream primitive is not reproducible, the target is not disposable, no benign canary exists, callback attribution is unavailable, or cleanup cannot be guaranteed. State which prerequisite is missing and which primary skill owns the unresolved lead.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for the exact bounded replay and `report_note` for the execution graph. Use an approved callback service only for nonce-only observation. Use source inspection to corroborate reachable APIs.

If direct observation is unavailable and no approved callback exists, stop. Do not invent a stronger payload.

## Handoffs and Duplicate Prevention

The upstream skill owns the injection or parser defect:

- `command-injection` owns shell or process argument injection;
- `ssti` owns template evaluation;
- `insecure-deserialization` owns unsafe object reconstruction;
- `path-traversal` owns path escape;
- `insecure-file-uploads` owns upload policy and storage behavior.

This skill owns only the bounded execution conclusion. Link the upstream evidence and create one finding when execution is the material impact; otherwise retain separate, non-duplicative leads.

## Stop, Cleanup, and Data Minimization

Stop at two nonce proofs plus the negative control, at three canary attempts, or on any unexpected side effect. Delete evaluator-created markers and expire callback tokens. Store hashes and redacted exchanges, not runtime output beyond the nonce.

Never perform destructive actions, persistence, lateral movement, privilege expansion, secret access, or post-proof exploration.

Research date: 2026-07-23

## Sources

- OWASP Web Security Testing Guide, Input Validation Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/
- CWE-94, Improper Control of Generation of Code: https://cwe.mitre.org/data/definitions/94.html
- CWE-78, Improper Neutralization of Special Elements used in an OS Command: https://cwe.mitre.org/data/definitions/78.html
