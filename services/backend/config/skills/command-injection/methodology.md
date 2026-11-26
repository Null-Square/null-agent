# Command Injection Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Use this package only when an in-scope request, job argument, filename, archive option, diagnostic field, or repository dataflow plausibly reaches an operating-system process boundary. Record the suspected shell family, argument position, quoting context, executing identity if known, and a clean baseline.

Do not infer command injection from a framework, `exec` symbol, shell error, or scanner label. If the value is passed as a fixed argument vector without shell interpretation and no option injection is possible, record that control and stop.

## Surface Discovery and Prioritization

1. Prioritize ping/traceroute, media conversion, archive, PDF, backup, build, webhook-test, and administrative diagnostic features.
2. In source mode, distinguish shell-string APIs (`sh -c`, `cmd /c`, language `system` helpers) from argument-array process APIs.
3. Identify whether input occupies command name, option, option value, filename, environment value, or shell-expanded text.
4. Capture asynchronous job identifiers and their result channel before probing; a queued `202` is not execution evidence.

## Safe Test Ladder

1. Establish two baseline requests and an equal-length inert delimiter control.
2. Try one syntax error that should be rejected without running an additional command; retain the exact stderr or normalized response.
3. Use a harmless, unique marker command appropriate to the observed shell. The marker may write only inside the evaluation workspace or appear in the direct response.
4. If output is blind, use a bounded delay of at most two seconds with three interleaved candidate/control pairs. Do not use an external callback unless the RoE explicitly allows the existing OOB service.
5. Repeat with one alternate separator or quoting form only when the baseline result is stable.

Use concurrency 1, at most 10 candidate requests per endpoint, and a five-second client timeout. Stop on any service-health change, queue growth, unexpected process behavior, or confirmed marker.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Injection Forms and Marker Reference

Prioritise features that shell out: ping/traceroute, media/PDF/image conversion, archive/backup, build hooks, webhook-test, and admin diagnostics.

Separator forms to reach a second command (try the minimum applicable, one at a time): `; marker`, `| marker`, `|| marker`, `&& marker`, newline `%0a marker`, substitution `$(marker)`, and backticks `` `marker` ``. For `cmd.exe` use `& marker`/`&& marker`; for PowerShell use `; marker`. Test leading-dash **argument injection** (`--option`) separately from shell metacharacters — an argument-array sink may still be option-injectable.

Injection locations beyond the obvious body field: query parameters, headers (`User-Agent`, `Referer`, `X-Forwarded-For`), and multipart filenames.

The marker is a harmless, unique, non-persistent proof — never a shell:

- **Visible:** a unique echo token in the response (`echo ns_<rand>`), or a bounded read like `id` when the response returns command output.
- **Workspace-only:** write a unique file inside the evaluation workspace and read it back.
- **Blind timing:** a bounded `sleep 2` / `ping -c 2` with three interleaved candidate/control pairs.
- **OOB:** only the existing evaluator OOB service when the RoE allows it.

The next step — a reverse/interactive shell, reading credentials or `/etc/shadow`, persistence, or pivoting — is outside bounded PoC. Record it as a blocked impact hypothesis and stop. Template-evaluation math probes (`{{7*7}}`) belong to `ssti`; hand them off rather than testing here.

## Variation Matrix

- POSIX shell separators: test only the minimum applicable separator among semicolon, logical-and, logical-or, pipe, or newline.
- Windows command parsing: distinguish `cmd.exe` metacharacters from PowerShell expression parsing; do not spray both families.
- Argument injection: test leading-dash option interpretation separately from shell metacharacters.
- Quote context: unquoted, single-quoted, double-quoted, or already escaped based on observed behavior.
- Decode boundary: canonical input before one URL, JSON, or form-decoding variation.
- Async execution: correlate submission, worker job, marker, and final status by one unique job id.

## Proof Standard

A proof requires a unique harmless marker or a reproducible bounded timing predicate attributable to the supplied value, plus a matched inert control and exact request/job evidence. A shell error is a lead. Source reachability is a lead until runtime evidence or a deterministic local fixture proves the process boundary.

## False Positives and Benign Lookalikes

1. The application implements ping or conversion internally without starting an OS process.
2. A validation layer rejects metacharacters and returns a generic shell-themed message.
3. The candidate and inert control both hit the same timeout because the worker queue is slow.
4. A scanner treats reflected punctuation or a `500` response as execution.
5. A process API receives a safe argument array and the suspected separator remains one literal argument.

## Missing Prerequisites and Blocked Behavior

Block when no safe marker channel exists, the job queue is unstable, the operating-system family cannot be established, or the only confirmation would modify external state. Preserve the suspected sink, baseline, attempted control, and exact missing observation.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` or replay tooling for one-variable request pairs, `http_differential` for interleaved timing, and `file_read` or connected-repository reads for source-to-sink tracing. Use `python_session` only to normalize captured timings or construct a local inert fixture. Do not open a general shell merely to expand payload volume.

## Handoffs and Duplicate Prevention

Hand argument-array and process-launch evidence to `source-aware-whitebox`; hand final candidate disposition to `validation`; hand a confirmed broader execution primitive to `rce` for synthesis without repeating the marker. Keep SSTI and deserialization under their own parser-specific owners.

## Stop, Cleanup, and Data Minimization

Stop at the first reproducible marker, after two failed syntax families, or at a safety cap. Remove test-only marker files, cancel test jobs, and retain only the minimal request, control, output, job id, and timing series. Never retain environment dumps, command output unrelated to proof, or secrets.

## Sources

- [OWASP WSTG - Testing for Command Injection](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/12-Testing_for_Command_Injection)
- [CWE-78: Improper Neutralization of Special Elements used in an OS Command](https://cwe.mitre.org/data/definitions/78.html)
