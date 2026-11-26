# Python Tooling Methodology

Use Python for bounded offline parsing, normalization, statistics, fixture construction, and protocol clients when first-class tools cannot preserve the required semantics. It is not a permission bypass or generic exploit runner.

## Preconditions and Fast Applicability

Require a concrete input/output contract, declared files/targets, rate/concurrency/memory/time caps, and a reason existing tools are insufficient. Default script timeout is 60 seconds, memory input 100 MiB, network disabled unless the owning skill permits exact targets.

## Surface Discovery and Prioritization

Define accepted input schema, deterministic transformation, output schema, errors, redaction, and cleanup before coding. Prefer standard library and installed dependencies; no package installation.

## Safe Test Ladder

1. Parse a tiny known fixture.
2. Validate malformed/empty input.
3. Run the bounded real artifact.
4. Emit JSON/JSONL with evidence IDs.
5. Cross-check one result manually or with another tool.
6. Remove temporary files.

## Variation Matrix

| Axis | Variants |
|---|---|
| input | known-good, malformed, bounded real |
| mode | offline, exact authorized network target |
| output | JSON/JSONL, stable sort/hashes |
| failure | timeout, parse error, missing dependency |
| resource | explicit bytes/items/concurrency |

## Proof Standard

The tool proves only that its deterministic transformation/output is correct against controls. It never creates a vulnerability finding by itself; the owning methodology interprets evidence.

## False Positives and Benign Lookalikes

- parser coercion can hide malformed data;
- unordered structures produce unstable diffs;
- local timezone/locale changes output;
- truncated input looks complete;
- cached files can be stale;
- exceptions can be mistaken for target behavior.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without input schema, safe limits, required installed module, or exact network authority. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Prefer `python_session` for inspected iterative analysis and a checked-in script for reproducibility. Use `argparse`, explicit timeouts, bounded reads, structured logs, and no dynamic code evaluation.

## Handoffs and Duplicate Prevention

The invoking skill owns scope/proof. `tooling-python` owns the reproducible transformation and resource limits only.

## Stop, Cleanup, and Data Minimization

Stop on output contract completion, timeout, or cap. Delete temp artifacts and redact secrets before serialization.

Never perform destructive actions, install packages, execute untrusted code, or broaden network access.

Research date: 2026-07-23

## Sources

- Python Standard Library: https://docs.python.org/3/library/
- Python `argparse`: https://docs.python.org/3/library/argparse.html
